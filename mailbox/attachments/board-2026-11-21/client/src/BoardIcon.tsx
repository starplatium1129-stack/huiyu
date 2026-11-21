const paths = {
  chat: ["M15.8 4.8 C6.3 2.5 2.8 5.4 3.2 12.4 Q3.5 17 8 17 L7.1 20.6 L12.4 17.1 C18.4 17.7 21.3 14.8 20.5 8.1", "M7.5 10.2 Q12.1 9.5 16.4 10.5"],
  desktop: ["M4.2 4.8 Q12 4.2 19.4 4.6 Q21 4.7 21 6.3 L20.7 14.8 Q20.7 16.4 18.9 16.4 L5 16.2 Q3.1 16.2 3.2 14.5 L3.3 7.2", "M12 16.4 L11.8 20 M8 20.1 L16.2 20"],
  gateway: ["M10.1 4.1 L3.8 8.2 L12 12.4 L20.2 7.8 L13.4 4.1", "M4.1 13 L12 17.2 L20.4 12.8 M4.4 17.2 L12 21 L19.7 16.9"],
  nene: ["M6.7 12.7 Q10.3 14.5 11.5 20.2 Q12.6 12.8 20.1 11.4 Q13.1 10.4 11.6 3.3 Q10.6 10.7 3.8 11.7"],
  check: ["M4.5 12.2 L9.4 17 Q14.6 11.6 19.5 6.5"],
  refresh: ["M19.8 9.1 C17.4 2.8 8.3 2.6 5.1 7.9 C1.1 14.5 7.5 22.9 15 19.4 Q18.4 17.9 19.5 14.9", "M19.6 4.6 L19.8 9.1 L15.3 9.5"],
  pause: ["M9.4 5.2 V18.8 M14.6 5.2 V18.8"],
  play: ["M7 4.3 Q6 3.8 6 5 V19 Q6 20.2 7 19.7 L20 12 Z"],
  chevron: ["M6.5 9.3 Q9.1 11.6 12 14.2 Q14.9 11.6 17.5 9.3"],
  sun: ["M14.6 8.5 C10.6 5.4 5.8 10 8.4 14.2 C10.8 18 17.2 15.3 16 11.2", "M11.3 2.9 L11.6 4.3 M12.4 19.7 L12.7 21.1 M2.9 12.7 L4.3 12.4 M19.7 11.6 L21.1 11.3 M5.3 5.9 L6.5 7 M17.5 17 L18.7 18.1 M6 18.7 L7 17.5 M17 6.5 L18.1 5.3"],
  moon: ["M10.3 3.6 C2.7 5.3 1.4 15.6 8.4 19.7 C13.2 22.5 18.2 19.9 20.2 15.1 C12.9 18.1 6.7 10.9 10.3 3.6 Z"],
  warning: ["M10.5 4.5 Q12 2.2 13.5 4.5 L20.5 17.5 Q22 20 19 20 H5 Q2 20 3.5 17.5 Z", "M12 8.5 V13.3 M12 16.4 V16.6"],
};

export type BoardIconName = keyof typeof paths;

// 绘遇 ArchiveIcon 的线条与图形定义，适配看板独立的 React 运行环境。
export function BoardIcon({ name }: { name: BoardIconName }) {
  return (
    <svg className="board-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      {paths[name].map((path) => <path key={path} d={path} />)}
    </svg>
  );
}
