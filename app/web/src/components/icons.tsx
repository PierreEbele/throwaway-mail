/** Small inline icons, same stroke style as the sidebar icons. */
function Svg({ d, className = "inline size-3.5 shrink-0 align-[-2px]" }: { d: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

export const LockIcon = ({ className }: { className?: string }) => <Svg className={className} d="M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3" />;
export const ShieldIcon = ({ className }: { className?: string }) => (
  <Svg className={className} d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
);
export const PaperclipIcon = ({ className }: { className?: string }) => (
  <Svg className={className} d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 17.5a2 2 0 0 1-3-3l7.5-7.5" />
);

export function PinIcon({ filled, className = "size-4" }: { filled?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <path d="M9 4h6l-1 5 4 3v2h-5v6l-1 1-1-1v-6H6v-2l4-3z" strokeLinejoin="round" />
    </svg>
  );
}
