const registry: Record<string, () => Promise<any>> = {};

export function registerPreload(path: string, importFn: () => Promise<any>) {
  registry[path] = importFn;
}

export function preloadRoute(path: string) {
  const preloader = registry[path];
  if (preloader) {
    preloader().catch((err) => {
      console.warn(`Failed to prefetch chunk for path ${path}:`, err);
    });
  }
}
