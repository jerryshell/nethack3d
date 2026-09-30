/**
 * 状态图标的内联 SVG。
 *
 * 纯代码绘制（16×16 视口，描边跟随文字颜色），不依赖外部素材；
 * HUD 的状态标签用它在文字前缀一个小图标，提高扫视识别度。
 */

/** 图标名到 SVG 路径的映射；描边色用 currentColor 继承标签颜色。 */
const PATHS: Record<string, string> = {
  // 失明：一只眼睛加斜杠。
  blind:
    '<circle cx="8" cy="8" r="2"/><path d="M1.5 8C3.5 4.5 5.5 3 8 3s4.5 1.5 6.5 5c-2 3.5-4 5-6.5 5S3.5 11.5 1.5 8z"/><path d="M3 13L13 3"/>',
  // 混乱：弯折的闪电状线条。
  confused: '<path d="M2 5c3-3 4 1 6-1s3 2 6-1"/><path d="M2 11c3-3 4 1 6-1s3 2 6-1"/>',
  // 睡眠：一个大写的 Z。
  sleep: '<path d="M5 3h6L5 13h6"/>',
  // 被缠住：两节锁链。
  held: '<circle cx="5" cy="8" r="3"/><circle cx="11" cy="8" r="3"/>',
  // 眩晕：四角星。
  stun: '<path d="M8 1l1.6 5.4L15 8l-5.4 1.6L8 15l-1.6-5.4L1 8l5.4-1.6z"/>',
  // 加速：双箭头。
  hasted: '<path d="M2 3l5 5-5 5M9 3l5 5-5 5"/>',
  // 心灵感应：同心圆。
  telepathy: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/>',
  // 浮空：上箭头加地面线。
  levitation: '<path d="M8 13V3M4 7l4-4 4 4"/><path d="M4 15h8"/>',
  // 溺水：三道波纹。
  drowning:
    '<path d="M2 5c2-2 4-2 6 0s4 2 6 0"/><path d="M2 9c2-2 4-2 6 0s4 2 6 0"/><path d="M2 13c2-2 4-2 6 0s4 2 6 0"/>',
  // 受罚：铁球加链条。
  punished: '<circle cx="12" cy="11" r="3.5"/><path d="M2 2l6 6"/>',
  // 石化中：菱形。
  petrifying: '<path d="M8 1l6 7-6 7-6-7z"/>',
  // 隐形：虚线圆。
  invisible: '<circle cx="8" cy="8" r="6" stroke-dasharray="3 2.5"/>',
  // 探测类共用一只眼睛。
  eye: '<circle cx="8" cy="8" r="2"/><path d="M1.5 8C3.5 4.5 5.5 3 8 3s4.5 1.5 6.5 5c-2 3.5-4 5-6.5 5S3.5 11.5 1.5 8z"/>',
  // 生病：水滴。
  sick: '<path d="M8 2c3 4.5 4.5 6 4.5 8a4.5 4.5 0 01-9 0c0-2 1.5-3.5 4.5-8z"/>',
  // 饥饿：朝下的箭头（往下掉的饱食度）。
  hunger: '<path d="M8 2v11M4 9l4 4 4-4"/>',
};

/** 取一个状态图标的 SVG 字符串；未知图标返回空串。 */
export function statusIconSvg(kind: string): string {
  const d = PATHS[kind];
  if (!d) return '';
  return (
    `<svg class="hud-chip-icon" viewBox="0 0 16 16" aria-hidden="true" ` +
    `fill="none" stroke="currentColor" stroke-width="1.6" ` +
    `stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
  );
}
