/**
 * Promise concurrency limiter.
 * Returns a function that takes an async task and returns a function that
 * maps over an array of items with bounded concurrency.
 */
export const pLimit =
  <T, R>(concurrency: number) =>
  (fn: (item: T) => Promise<R>) =>
  (items: T[]): Promise<R[]> => {
    if (concurrency === 1) {
      return (async () => {
        const results: R[] = [];
        for (const item of items) {
          results.push(await fn(item));
        }
        return results;
      })();
    }

    return new Promise((resolve, reject) => {
      if (items.length === 0) {
        resolve([]);
        return;
      }

      const results = new Array<R>(items.length);
      let currentIndex = 0;
      let activeCount = 0;
      let completedCount = 0;
      let isSettled = false;

      const resolveIfComplete = () => {
        if (completedCount !== items.length || isSettled) return;
        isSettled = true;
        resolve(results);
      };

      const rejectOnce = (error: unknown) => {
        if (isSettled) return;
        isSettled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const processNext = () => {
        if (isSettled) return;

        while (activeCount < concurrency && currentIndex < items.length) {
          const index = currentIndex++;
          const item = items[index] as T;
          activeCount++;
          fn(item)
            .then((result) => {
              results[index] = result;
              activeCount--;
              completedCount++;
              resolveIfComplete();
              processNext();
            })
            .catch((error: unknown) => {
              activeCount--;
              rejectOnce(error);
            });
        }
      };

      processNext();
    });
  };
