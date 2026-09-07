import { useState, useEffect } from 'react';

/**
 * Debounces a value by delaying updates until after `delayMs` milliseconds
 * have elapsed since the last change. Essential for search boxes filtering large
 * in-memory lists to prevent UI keystroke stutter.
 */
export function useDebounce<T>(value: T, delayMs: number = 200): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debouncedValue;
}
