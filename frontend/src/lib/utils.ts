import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes with correct precedence (shadcn/ui convention, as in Camera_Trap). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
