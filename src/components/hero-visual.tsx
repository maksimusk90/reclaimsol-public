export function HeroVisual() {
  return (
    <div className="hero-visual" aria-hidden="true">
      <div className="hero-visual-grid" />
      <div className="hero-visual-aura" />
      <svg viewBox="0 0 760 360" role="presentation" focusable="false">
        <defs>
          <linearGradient id="reclaim-core" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#c4b5fd" />
            <stop offset=".52" stopColor="#8b5cf6" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
          <linearGradient id="reclaim-line" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#8b5cf6" stopOpacity="0" />
            <stop offset=".5" stopColor="#a78bfa" stopOpacity=".9" />
            <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
          </linearGradient>
          <filter id="reclaim-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="12" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <ellipse cx="380" cy="180" rx="278" ry="104" fill="none" stroke="#8b5cf6" strokeOpacity=".17" strokeWidth="1" transform="rotate(-13 380 180)" />
        <ellipse cx="380" cy="180" rx="224" ry="142" fill="none" stroke="#22d3ee" strokeOpacity=".14" strokeWidth="1" transform="rotate(21 380 180)" />
        <ellipse cx="380" cy="180" rx="164" ry="164" fill="none" stroke="#a78bfa" strokeOpacity=".12" strokeWidth="1" />
        <path d="M42 180H718" stroke="url(#reclaim-line)" strokeWidth="1" strokeDasharray="4 9" />
        <path d="M380 22V338" stroke="#8b5cf6" strokeOpacity=".14" strokeDasharray="3 9" />
        <g className="hero-orbit hero-orbit-a"><circle cx="380" cy="76" r="5" fill="#22d3ee" filter="url(#reclaim-glow)" /></g>
        <g className="hero-orbit hero-orbit-b"><circle cx="602" cy="180" r="4" fill="#a78bfa" filter="url(#reclaim-glow)" /></g>
        <g className="hero-orbit hero-orbit-c"><circle cx="380" cy="284" r="4" fill="#22d3ee" filter="url(#reclaim-glow)" /></g>
        <g className="hero-core" filter="url(#reclaim-glow)">
          <circle cx="380" cy="180" r="79" fill="#17142c" stroke="#a78bfa" strokeOpacity=".7" />
          <circle cx="380" cy="180" r="67" fill="none" stroke="url(#reclaim-core)" strokeOpacity=".75" strokeWidth="1.5" />
          <path d="M341 151H419L402 168H341V151Z" fill="url(#reclaim-core)" />
          <path d="M341 176H419L402 193H341V176Z" fill="url(#reclaim-core)" />
          <path d="M341 201H419L402 218H341V201Z" fill="url(#reclaim-core)" />
        </g>
        <g fill="#c4b5fd" fontFamily="Arial, sans-serif" fontSize="10" letterSpacing="2">
          <text x="96" y="116">RECLAIM</text>
          <text x="96" y="132" fill="#7f8ba6" fontSize="8">LOCKED RENT</text>
          <text x="566" y="239">RETURN</text>
          <text x="566" y="255" fill="#7f8ba6" fontSize="8">YOUR WALLET</text>
        </g>
        <path d="M145 145C210 145 230 180 285 180M475 180C530 180 550 215 615 215" fill="none" stroke="url(#reclaim-line)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="145" cy="145" r="3" fill="#8b5cf6" />
        <circle cx="615" cy="215" r="3" fill="#22d3ee" />
        <g fill="#fff" fillOpacity=".7">
          <circle cx="230" cy="76" r="1.5" /><circle cx="530" cy="95" r="1.5" /><circle cx="185" cy="260" r="1" /><circle cx="570" cy="285" r="1.5" /><circle cx="300" cy="305" r="1" /><circle cx="470" cy="52" r="1" />
        </g>
      </svg>
      <div className="hero-visual-caption"><span /> SOLANA RENT RECOVERY · NON-CUSTODIAL</div>
    </div>
  );
}
