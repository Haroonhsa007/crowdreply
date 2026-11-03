export function Brand() {
  return (
    <span className="brand">
      <svg
        className="brand-mark"
        viewBox="0 0 32 32"
        width="30"
        height="30"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M5 5h17a5 5 0 0 1 5 5v8a5 5 0 0 1-5 5h-9l-8 5V5Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="m15 11-4 4 4 4m-3-4h9"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="brand-name">
        crowd<span>reply</span>
      </span>
    </span>
  );
}
