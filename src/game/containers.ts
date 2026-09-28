/**
 * 容器：箱子与袋子。
 *
 * 容器按 id 识别并给定容量；物品可以放进去再取出，诅咒的容器打不开，
 * 口袋袋打开时会放出怪物。容量只是件数上限，没有重量系统。
 */

import type { ItemInstance } from '../types';

/** 容器 id 到容纳件数。 */
export const CONTAINER_CAPACITY: Record<string, number> = {
  LARGE_BOX: 20,
  CHEST: 20,
  ICE_BOX: 8,
  SACK: 8,
  OILSKIN_SACK: 8,
  BAG_OF_HOLDING: 20,
  BAG_OF_TRICKS: 8,
};

/** 是否是可以装东西的容器。 */
export function isContainer(item: ItemInstance): boolean {
  return item.proto.id in CONTAINER_CAPACITY;
}

/** 容器容量；不是容器时返回 0。 */
export function containerCapacity(item: ItemInstance): number {
  return CONTAINER_CAPACITY[item.proto.id] ?? 0;
}

/** 容器是否还有空间。 */
export function containerHasRoom(item: ItemInstance): boolean {
  return isContainer(item) && (item.contents?.length ?? 0) < containerCapacity(item);
}
