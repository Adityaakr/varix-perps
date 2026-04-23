type VarixLogoProps = {
  compact?: boolean;
};

export function VarixLogo({ compact = false }: VarixLogoProps) {
  return (
    <svg
      aria-label="Varix"
      className={`varix-logo${compact ? " varix-logo--compact" : ""}`}
      viewBox={compact ? "0 0 162 82" : "0 0 390 92"}
      role="img"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="varix-ember" x1="6" x2="124" y1="8" y2="74" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fe5a00" />
          <stop offset="1" stopColor="#fe5a00" />
        </linearGradient>
        <linearGradient id="varix-cream" x1="74" x2="152" y1="12" y2="76" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff1dd" />
          <stop offset="1" stopColor="#e7cdbb" />
        </linearGradient>
      </defs>
      <g className="varix-logo__mark">
        <path d="M10 12h46l42 58H52L10 12Z" fill="url(#varix-ember)" />
        <path d="M101 12h48l-32 31 35 27h-49L74 47l27-35Z" fill="url(#varix-cream)" />
        <path d="M83 48 98 35l6 18-17 13-4-18Z" fill="#180f09" opacity="0.54" />
      </g>
      {!compact ? (
        <text
          className="varix-logo__word"
          x="190"
          y="66"
          fill="#f3dfce"
          fontFamily="Inter, Arial, sans-serif"
          fontSize="58"
          fontWeight="800"
          letterSpacing="0"
        >
          varix
        </text>
      ) : null}
    </svg>
  );
}
