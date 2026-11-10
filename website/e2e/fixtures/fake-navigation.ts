declare global {
  interface Window {
    __refreshed?: number;
    __path?: string;
  }
}

// Stands in for next/navigation in the offline upload-panel test: refresh() only counts how often it was called.
export function useRouter() {
  return {
    refresh() {
      window.__refreshed = (window.__refreshed ?? 0) + 1;
    },
  };
}
export function notFound(): never {
  throw new Error("notFound");
}
export function usePathname() {
  return window.__path ?? "/admin";
}
