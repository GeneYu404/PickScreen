import { clsx, type ClassValue } from "clsx";

/**
 * 样式层已从 Tailwind 迁移到原生 CSS（语义类 + CSS 变量令牌），
 * twMerge 的作用是消解 Tailwind 类组之间的冲突，对自定义语义类无意义，故已移除。
 */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}
