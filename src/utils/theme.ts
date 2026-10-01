/**
 * 主题跟随系统：仅在 <html> 上切换 data-theme，
 * 颜色全部由 index.css 里的 CSS 变量提供，组件不感知具体色值。
 */
export function applySystemTheme(): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const sync = () => {
    const dark = !mq.matches;
    const root = document.documentElement;
    if (dark) root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
  };
  sync();
  mq.addEventListener('change', sync);
  return () => mq.removeEventListener('change', sync);
}
