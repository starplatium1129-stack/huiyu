<template>
  <!-- 内联受控字标（母版同源 assets/brand-mark.svg）：绕开 <img> SVG 沙箱导致的
       Windows SimSun 强制退化，直接继承 --font-serif 与主题配色，无滤镜发光（DESIGN.md:854）。 -->
  <svg
    class="brand-logo"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 132 48"
    width="132"
    height="48"
    role="img"
    aria-label="绘遇 · HUIYU"
    focusable="false"
  >
    <g aria-hidden="true">
      <g class="brand-mark" transform="translate(0 0) scale(2)">
        <path
          d="M8.5 6.7L17.6 3.1Q19.1 2.5 19.1 4.2V18Q19.1 19.4 17.7 20L13 21.8M5.8 8V20.6Q5.8 22 7.1 21.4L9.2 20.5Q10.6 19.9 10.6 18.4V12.8Q10.6 9.8 5.8 8M10.6 12.8C10.6 16.8 14.8 19.2 18.8 18.6"
          fill="none"
          stroke="var(--brand-mark)"
          stroke-width="1.65"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </g>
      <g class="brand-wordmark">
        <text class="brand-title" x="58" y="30" font-size="29" font-weight="700" letter-spacing="3">绘遇</text>
        <text class="brand-latin" x="60" y="44" font-size="9" font-weight="600" letter-spacing="4">HUIYU</text>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.brand-logo {
  --brand-mark: #F2A8BE;
  --brand-ink: #FFF8F4;
  display: block;
  aspect-ratio: 132 / 48;
  user-select: none;
  pointer-events: none;
}
/* Terraria 木质顶栏始终为深木底。字标跟随文档已经显示的主题。 */
:root[data-theme="light"]:not([data-theme-style="terraria"]) .brand-logo {
  --brand-mark: #9B3E61;
  --brand-ink: #211C30;
}
.brand-wordmark {
  fill: var(--brand-ink);
}
.brand-title {
  font-family: var(--font-serif);
}
.brand-latin {
  font-family: var(--font-sans);
}
@media (forced-colors: active) {
  .brand-logo {
    --brand-mark: currentColor;
    --brand-ink: currentColor;
  }
}
</style>
