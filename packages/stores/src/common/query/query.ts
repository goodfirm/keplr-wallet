import {
  action,
  autorun,
  flow,
  makeObservable,
  observable,
  onBecomeObserved,
  onBecomeUnobserved,
  reaction,
} from "mobx";
import { KVStore, toGenerator } from "@keplr-wallet/common";
import { HasMapStore } from "../map";
import EventEmitter from "eventemitter3";
import { makeURL, simpleFetch } from "@keplr-wallet/simple-fetch";
import { QuerySharedContext } from "./context";

export type QueryOptions = {
  // millisec
  readonly cacheMaxAge: number;
  // millisec
  readonly fetchingInterval: number;
};

export const defaultOptions: QueryOptions = {
  cacheMaxAge: 0,
  fetchingInterval: 0,
};

export type QueryError<E> = {
  status: number;
  statusText: string;
  message: string;
  data?: E;
};

export type QueryResponse<T> = {
  status: number;
  data: T;
  staled: boolean;
  timestamp: number;
};

class FlowCancelerError extends Error {
  constructor(m?: string) {
    super(m);
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, FlowCancelerError.prototype);
  }
}

class FlowCanceler {
  protected rejectors: {
    reject: (e: Error) => void;
    onCancel?: () => void;
  }[] = [];

  get hasCancelable(): boolean {
    return this.rejectors.length > 0;
  }

  cancel(message?: string) {
    while (this.rejectors.length > 0) {
      const rejector = this.rejectors.shift();
      if (rejector) {
        rejector.reject(new FlowCancelerError(message));
        if (rejector.onCancel) {
          rejector.onCancel();
        }
      }
    }
  }

  callOrCanceledWithPromise<R>(
    promise: PromiseLike<R>,
    onCancel?: () => void
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.rejectors.push({
        reject,
        onCancel,
      });

      promise.then(
        (r) => {
          const i = this.rejectors.findIndex((r) => r.reject === reject);
          if (i >= 0) {
            this.rejectors.splice(i, 1);
          }

          resolve(r);
        },
        (e) => {
          const i = this.rejectors.findIndex((r) => r.reject === reject);
          if (i >= 0) {
            this.rejectors.splice(i, 1);
          }

          reject(e);
        }
      );
    });
  }

  callOrCanceled<R>(
    fn: () => PromiseLike<R>,
    onCancel?: () => void
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.rejectors.push({
        reject,
        onCancel,
      });

      Promise.resolve().then(() => {
        if (!this.rejectors.find((r) => r.reject === reject)) {
          return;
        }

        fn().then(
          (r) => {
            const i = this.rejectors.findIndex((r) => r.reject === reject);
            if (i >= 0) {
              this.rejectors.splice(i, 1);
            }

            resolve(r);
          },
          (e) => {
            const i = this.rejectors.findIndex((r) => r.reject === reject);
            if (i >= 0) {
              this.rejectors.splice(i, 1);
            }

            reject(e);
          }
        );
      });
    });
  }
}

class FunctionQueue {
  protected queue: (() => void | Promise<void>)[] = [];
  protected isPendingPromise = false;

  enqueue(fn: () => void | Promise<void>) {
    this.queue.push(fn);

    this.handleQueue();
  }

  protected handleQueue() {
    if (!this.isPendingPromise && this.queue.length > 0) {
      const fn = this.queue.shift();
      if (fn) {
        const r = fn();
        if (typeof r === "object" && "then" in r) {
          this.isPendingPromise = true;
          r.then(() => {
            this.isPendingPromise = false;
            this.handleQueue();
          });
        } else {
          this.handleQueue();
        }
      }
    }
  }
}

export const querySharedContext = new QuerySharedContext();

/**
 * Base of the observable query classes.
 * This recommends to use the fetch to query the response.
 */
export abstract class ObservableQueryBase<T = unknown, E = unknown> {
  protected static suspectedResponseDatasWithInvalidValue: string[] = [
    "The network connection was lost.",
    "The request timed out.",
  ];

  protected static guessResponseTruncated(headers: any, data: string): boolean {
    return (
      headers &&
      typeof headers["content-type"] === "string" &&
      headers["content-type"].startsWith("application/json") &&
      data.startsWith("{")
    );
  }

  protected readonly options: QueryOptions;

  // Just use the oberable ref because the response is immutable and not directly adjusted.
  @observable.ref
  private _response?: Readonly<QueryResponse<T>> = undefined;

  @observable
  protected _isFetching: boolean = false;

  @observable.ref
  private _error?: Readonly<QueryError<E>> = undefined;

  @observable
  private _isStarted: boolean = false;

  private stateQueue = new FunctionQueue();
  private pendingOnStart = false;
  private readonly queryCanceler: FlowCanceler;

  private observedCount: number = 0;

  // intervalId can be number or NodeJS's Timout object according to the environment.
  // If environment is browser, intervalId should be number.
  // If environment is NodeJS, intervalId should be NodeJS.Timeout.
  private intervalId: number | NodeJS.Timeout | undefined = undefined;

  @observable
  protected baseURL: string;

  @observable
  protected _url: string = "";

  protected constructor(
    protected readonly kvStore: KVStore,
    baseURL: string,
    url: string,
    options: Partial<QueryOptions>
  ) {
    this.options = {
      ...defaultOptions,
      ...options,
    };

    this.baseURL = baseURL;

    this.queryCanceler = new FlowCanceler();

    makeObservable(this);

    this.setUrl(url);

    onBecomeObserved(this, "_response", this.becomeObserved);
    onBecomeObserved(this, "_isFetching", this.becomeObserved);
    onBecomeObserved(this, "_error", this.becomeObserved);

    onBecomeUnobserved(this, "_response", this.becomeUnobserved);
    onBecomeUnobserved(this, "_isFetching", this.becomeUnobserved);
    onBecomeUnobserved(this, "_error", this.becomeUnobserved);
  }

  private becomeObserved = (): void => {
    if (this.observedCount === 0) {
      this.start();
    }
    this.observedCount++;
  };

  private becomeUnobserved = (): void => {
    this.observedCount--;
    if (this.observedCount === 0) {
      this.stop();
    }
  };

  public get isObserved(): boolean {
    return this.observedCount > 0;
  }

  @action
  private start() {
    if (!this._isStarted) {
      this._isStarted = true;
      // For async onStart() method, set isFetching as true in advance.
      this._isFetching = true;
      this.pendingOnStart = true;
      this.stateQueue.enqueue(() => {
        return this.onStart();
      });
      this.stateQueue.enqueue(() => {
        this.pendingOnStart = false;
      });
      this.stateQueue.enqueue(() => {
        return this.postStart();
      });
    }
  }

  @action
  private stop() {
    if (this._isStarted) {
      if (this.isFetching && this.queryCanceler.hasCancelable) {
        this.cancel();
      }

      this._isFetching = false;

      if (this.intervalId != null) {
        clearInterval(this.intervalId as NodeJS.Timeout);
      }
      this.intervalId = undefined;

      this.stateQueue.enqueue(() => {
        return this.onStop();
      });
      this._isStarted = false;
    }
  }

  public get isStarted(): boolean {
    return this._isStarted;
  }

  private readonly intervalFetch = () => {
    if (!this.isFetching) {
      this.fetch();
    }
  };

  private postStart() {
    this.fetch();

    if (this.options.fetchingInterval > 0) {
      this.intervalId = setInterval(
        this.intervalFetch,
        this.options.fetchingInterval
      );
    }
  }

  protected onStart(): void | Promise<void> {
    // noop yet.
    // Override this if you need something to do whenever starting.
  }

  protected onStop(): void {
    // noop yet.
    // Override this if you need something to do whenever starting.
  }

  protected canFetch(): boolean {
    return true;
  }

  get isFetching(): boolean {
    return this._isFetching;
  }

  @flow
  *fetch(): Generator<unknown, any, any> {
    // If not started, do nothing.
    if (!this.isStarted || this.pendingOnStart) {
      return;
    }

    if (!this.canFetch()) {
      if (this._isFetching) {
        this._isFetching = false;
      }
      return;
    }

    // If response is fetching, cancel the previous query.
    if (this.isFetching && this.queryCanceler.hasCancelable) {
      // When cancel for the next fetching, it behaves differently from other explicit cancels because fetching continues. Use an error message to identify this.
      this.cancel("__fetching__proceed__next__");
    }

    // If there is no existing response, try to load saved reponse.
    if (!this._response) {
      this._isFetching = true;

      const handleStaledResponse = (
        staledResponse: QueryResponse<T> | undefined
      ) => {
        if (staledResponse && !this._response) {
          if (
            this.options.cacheMaxAge <= 0 ||
            staledResponse.timestamp > Date.now() - this.options.cacheMaxAge
          ) {
            this.setResponse(staledResponse);
            return true;
          }
        }
        return false;
      };

      let satisfyCache = false;

      // When first load, try to load the last response from disk.
      // Use the last saved response if the last saved response exists and the current response hasn't been set yet.
      const promise = querySharedContext.loadStore<
        QueryResponse<T> | undefined
      >(this.kvStore, this.getCacheKey(), (res) => {
        if (res.status === "rejected") {
          console.warn("Failed to get the last response from disk.");
        } else {
          let response = res.value;
          if (response) {
            response = {
              ...response,
              staled: true,
            };
          }
          satisfyCache = handleStaledResponse(response);
        }
      });
      if (this.options.cacheMaxAge <= 0) {
        // To improve performance, don't wait the loading to proceed if cache age not set.
      } else {
        yield promise;
        if (satisfyCache) {
          this._isFetching = false;
          return;
        }
      }
    } else {
      if (this.options.cacheMaxAge > 0) {
        if (this._response.timestamp > Date.now() - this.options.cacheMaxAge) {
          this._isFetching = false;
          return;
        }
      }

      this._isFetching = true;

      // Make the existing response as staled.
      this.setResponse({
        ...this._response,
        staled: true,
      });
    }

    const abortController = new AbortController();

    let fetchingProceedNext = false;

    try {
      let hasStarted = false;
      let { response, headers } = yield* toGenerator(
        this.queryCanceler.callOrCanceled(
          () => {
            hasStarted = true;
            return this.fetchResponse(abortController);
          },
          () => {
            if (hasStarted) {
              abortController.abort();
            }
          }
        )
      );
      if (
        response.data &&
        typeof response.data === "string" &&
        (response.data.startsWith("stream was reset:") ||
          ObservableQuery.suspectedResponseDatasWithInvalidValue.includes(
            response.data
          ) ||
          ObservableQuery.guessResponseTruncated(headers, response.data))
      ) {
        // In some devices, it is a http ok code, but a strange response is sometimes returned.
        // It's not that they can't query at all, it seems that they get weird response from time to time.
        // These causes are not clear.
        // To solve this problem, if this problem occurs, try the query again, and if that fails, an error is raised.
        // https://github.com/chainapsis/keplr-wallet/issues/275
        // https://github.com/chainapsis/keplr-wallet/issues/278
        // https://github.com/chainapsis/keplr-wallet/issues/318
        if (abortController.signal.aborted) {
          // In this case, it is assumed that it is caused by cancel() and do nothing.
          return;
        }

        console.log(
          "There is an unknown problem to the response. Request one more time."
        );

        // Try to query again.
        let hasStarted = false;
        const refetched = yield* toGenerator(
          this.queryCanceler.callOrCanceled(
            () => {
              hasStarted = true;
              return this.fetchResponse(abortController);
            },
            () => {
              if (hasStarted) {
                abortController.abort();
              }
            }
          )
        );
        response = refetched.response;
        headers = refetched.headers;

        if (response.data && typeof response.data === "string") {
          if (
            response.data.startsWith("stream was reset:") ||
            ObservableQuery.suspectedResponseDatasWithInvalidValue.includes(
              response.data
            )
          ) {
            throw new Error(response.data);
          }

          if (ObservableQuery.guessResponseTruncated(headers, response.data)) {
            throw new Error("The response data seems to be truncated");
          }
        }
      }

      // Should not wait.
      this.saveResponse(response);

      yield querySharedContext.handleResponse(() => {
        this.setResponse(response);
        // Clear the error if fetching succeeds.
        this.setError(undefined);
      });
    } catch (e) {
      if (e instanceof FlowCancelerError) {
        // When cancel for the next fetching, it behaves differently from other explicit cancels because fetching continues.
        if (e.message === "__fetching__proceed__next__") {
          fetchingProceedNext = true;
        }
        return;
      }

      // If error is from simple fetch, and get response.
      if (e.response) {
        // Default is status text
        let message: string = e.response.statusText;
        const contentType: string =
          typeof e.response.headers?.["content-type"] === "string"
            ? e.response.headers["content-type"]
            : "";
        // Try to figure out the message from the response.
        // If the contentType in the header is specified, try to use the message from the response.
        if (
          contentType.startsWith("text/plain") &&
          typeof e.response.data === "string"
        ) {
          message = e.response.data;
        }
        // If the response is an object and "message" field exists, it is used as a message.
        if (
          contentType.startsWith("application/json") &&
          e.response.data?.message &&
          typeof e.response.data?.message === "string"
        ) {
          message = e.response.data.message;
        }

        const error: QueryError<E> = {
          status: e.response.status,
          statusText: e.response.statusText,
          message,
          data: e.response.data,
        };

        yield querySharedContext.handleResponse(() => {
          this.setError(error);
        });
      } else if (e.request) {
        // if can't get the response.
        const error: QueryError<E> = {
          status: 0,
          statusText: "Failed to get response",
          message: "Failed to get response",
        };

        yield querySharedContext.handleResponse(() => {
          this.setError(error);
        });
      } else {
        const error: QueryError<E> = {
          status: 0,
          statusText: e.message,
          message: e.message,
          data: e,
        };

        yield querySharedContext.handleResponse(() => {
          this.setError(error);
        });
      }
    } finally {
      if (!fetchingProceedNext) {
        this._isFetching = false;
      }
    }
  }

  public get response() {
    return this._response;
  }

  public get error() {
    return this._error;
  }

  @action
  protected setResponse(response: Readonly<QueryResponse<T>>) {
    this._response = response;
  }

  @action
  protected setError(error: QueryError<E> | undefined) {
    this._error = error;
  }

  private cancel(message?: string): void {
    this.queryCanceler.cancel(message);
  }

  get url(): string {
    return this._url;
  }

  @action
  protected setUrl(url: string) {
    if (this._url !== url) {
      this._url = url;
      this.fetch();
    }
  }

  /**
   * Wait the response and return the response without considering it is staled or fresh.
   */
  waitResponse(): Promise<Readonly<QueryResponse<T>> | undefined> {
    if (this.response) {
      return Promise.resolve(this.response);
    }

    const disposers: (() => void)[] = [];
    let onceCoerce = false;
    // Make sure that the fetching is tracked to force to be fetched.
    disposers.push(
      reaction(
        () => this.isFetching,
        () => {
          if (!onceCoerce) {
            if (!this.isFetching) {
              this.fetch();
            }
            onceCoerce = true;
          }
        },
        {
          fireImmediately: true,
        }
      )
    );

    return new Promise<Readonly<QueryResponse<T>> | undefined>((resolve) => {
      const disposer = autorun(() => {
        if (!this.isFetching) {
          resolve(this.response);
        }
      });
      disposers.push(disposer);
    }).finally(() => {
      for (const disposer of disposers) {
        disposer();
      }
    });
  }

  /**
   * Wait the response and return the response until it is fetched.
   */
  waitFreshResponse(): Promise<Readonly<QueryResponse<T>> | undefined> {
    const disposers: (() => void)[] = [];
    let onceCoerce = false;
    // Make sure that the fetching is tracked to force to be fetched.
    disposers.push(
      reaction(
        () => this.isFetching,
        () => {
          if (!onceCoerce) {
            if (!this.isFetching) {
              this.fetch();
            }
            onceCoerce = true;
          }
        },
        {
          fireImmediately: true,
        }
      )
    );

    return new Promise<Readonly<QueryResponse<T>> | undefined>((resolve) => {
      const disposer = autorun(() => {
        if (!this.isFetching) {
          resolve(this.response);
        }
      });
      disposers.push(disposer);
    }).finally(() => {
      for (const disposer of disposers) {
        disposer();
      }
    });
  }

  protected getCacheKey(): string {
    return makeURL(this.baseURL, this.url);
  }

  protected abstract fetchResponse(
    abortController: AbortController
  ): Promise<{ response: QueryResponse<T>; headers: any }>;

  /**
   * Used for saving the last response to disk.
   * This should not make observable state changes.
   * @param response
   * @protected
   */
  protected async saveResponse(
    response: Readonly<QueryResponse<T>>
  ): Promise<void> {
    const key = this.getCacheKey();
    await this.kvStore.set(key, response);
  }
}

/**
 * ObservableQuery defines the event class to query the result from endpoint.
 * This supports the stale state if previous query exists.
 */
export class ObservableQuery<
  T = unknown,
  E = unknown
> extends ObservableQueryBase<T, E> {
  protected static eventListener: EventEmitter = new EventEmitter();

  public static refreshAllObserved() {
    ObservableQuery.eventListener.emit("refresh");
  }

  public static refreshAllObservedIfError() {
    ObservableQuery.eventListener.emit("refresh", {
      ifError: true,
    });
  }

  constructor(
    kvStore: KVStore,
    baseURL: string,
    url: string,
    options: Partial<QueryOptions> = {}
  ) {
    super(kvStore, baseURL, url, options);
    makeObservable(this);
  }

  protected override onStart(): void | Promise<void> {
    super.onStart();

    ObservableQuery.eventListener.addListener("refresh", this.refreshHandler);
  }

  protected override onStop(): void {
    super.onStop();

    ObservableQuery.eventListener.addListener("refresh", this.refreshHandler);
  }

  protected readonly refreshHandler = (data: any) => {
    const ifError = data?.ifError;
    if (ifError) {
      if (this.error) {
        this.fetch();
      }
    } else {
      this.fetch();
    }
  };

  protected async fetchResponse(
    abortController: AbortController
  ): Promise<{ response: QueryResponse<T>; headers: any }> {
    const result = await simpleFetch<T>(this.baseURL, this.url, {
      signal: abortController.signal,
    });
    return {
      headers: result.headers,
      response: {
        data: result.data,
        status: result.status,
        staled: false,
        timestamp: Date.now(),
      },
    };
  }
}

export class ObservableQueryMap<T = unknown, E = unknown> extends HasMapStore<
  ObservableQuery<T, E>
> {
  constructor(creater: (key: string) => ObservableQuery<T, E>) {
    super(creater);
  }
}
