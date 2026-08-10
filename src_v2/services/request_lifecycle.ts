/**
 * Shared cancellation helpers for long-lived HTTP turns.
 *
 * A native Codex turn is represented by an HTTP response in the gateway. If
 * the native client interrupts that turn, the response closes first; every
 * provider fetch and child request must observe the same abort signal or the
 * abandoned turn can keep the shared app-server busy.
 */

function abortReason(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("Request was aborted", "AbortError");
}

export type ResponseAbortBinding = {
  signal: AbortSignal;
  cleanup: () => void;
};

/** Bind a ServerResponse's close/finish lifecycle to an AbortSignal. */
export function bindResponseAbort(response: any): ResponseAbortBinding {
  const controller = new AbortController();
  let cleaned = false;

  const remove = (event: string, listener: () => void): void => {
    if (typeof response?.off === "function") response.off(event, listener);
    else if (typeof response?.removeListener === "function") response.removeListener(event, listener);
  };

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    remove("close", onClose);
    remove("finish", onFinish);
  };

  const onClose = (): void => {
    // `finish` normally runs before `close` for a successful response. A
    // close without a finished response is the cancellation boundary.
    if (!response?.writableEnded && !response?.writableFinished) {
      controller.abort(new DOMException("Client disconnected", "AbortError"));
    }
    cleanup();
  };
  const onFinish = (): void => cleanup();

  if (typeof response?.once === "function") {
    response.once("close", onClose);
    response.once("finish", onFinish);
  }

  return { signal: controller.signal, cleanup };
}

/** Forward a parent abort into a local controller and return the detach hook. */
export function linkAbortSignal(parent: AbortSignal | undefined, controller: AbortController): () => void {
  if (!parent) return () => {};
  const onAbort = (): void => controller.abort(abortReason(parent));
  if (parent.aborted) onAbort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

/** Read one stream chunk with both cancellation and an idle timeout. */
export function readWithAbortAndTimeout<T>(
  read: () => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage: string,
  cancel?: () => void,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback: (value: any) => void, value: any): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = (): void => {
      cancel?.();
      finish(reject, abortReason(signal));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cancel?.();
      finish(reject, new Error(timeoutMessage));
    }, Math.max(1, Math.floor(timeoutMs)));
    Promise.resolve()
      .then(read)
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
