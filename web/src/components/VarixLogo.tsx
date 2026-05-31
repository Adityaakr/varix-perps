type VarixLogoProps = {
  compact?: boolean;
};

export function VarixLogo({ compact = false }: VarixLogoProps) {
  return (
    <svg
      aria-label="Varix"
      className={`varix-logo ${compact ? "varix-logo--compact" : ""}`}
      fill="none"
      role="img"
      viewBox="0 0 320 96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect height="84" rx="24" stroke="#f2a900" strokeOpacity="0.34" strokeWidth="3" width="84" x="6" y="6" />
      <rect fill="#060504" height="70" rx="20" width="70" x="13" y="13" />
      <path d="M30 36h42l-8 10H22l8-10Z" fill="#56f0d2" />
      <path d="M25 53h42l-8 10H17l8-10Z" fill="#2f8cff" />
      <path d="M50 67h10l-5 6-5-6Z" fill="#f2a900" />
      <path d="M34 67h10l-5 6-5-6Z" fill="#56f0d2" />
      {!compact ? (
        <>
          <text fill="#fff2df" fontFamily="Inter, Arial, sans-serif" fontSize="42" fontWeight="800" x="108" y="47">
            Varix
          </text>
          <text fill="#ff5a1f" fontFamily="Inter, Arial, sans-serif" fontSize="22" fontWeight="800" x="110" y="75">
            Perps
          </text>
        </>
      ) : null}
    </svg>
  );
}
