import { bump } from './store.mjs';

// 景区基础地形：分区、步道、计数设备。住宿酒店按上报中的 hotel_id 隐式登记。
export const SEED = {
  zones: [
    { zone_id: 'z-cloud', name: '云杉谷', base_limit: 800 },
    { zone_id: 'z-creek', name: '溪流源', base_limit: 500 },
    { zone_id: 'z-rhodo', name: '杜鹃坡', base_limit: 600 },
  ],
  trails: [
    { trail_id: 't-summit', zone_id: 'z-cloud', name: '云顶步道' },
    { trail_id: 't-canopy', zone_id: 'z-cloud', name: '林冠栈道' },
    { trail_id: 't-creek', zone_id: 'z-creek', name: '溯溪步道' },
    { trail_id: 't-rhodo', zone_id: 'z-rhodo', name: '花海环线' },
  ],
  counters: [
    { counter_id: 'c-cloud-n', zone_id: 'z-cloud' },
    { counter_id: 'c-cloud-s', zone_id: 'z-cloud' },
    { counter_id: 'c-creek', zone_id: 'z-creek' },
    { counter_id: 'c-rhodo', zone_id: 'z-rhodo' },
  ],
};

export function seedStore(store, nowMs) {
  for (const zone of SEED.zones) store.zones.set(zone.zone_id, { ...zone });
  for (const trail of SEED.trails) {
    store.trails.set(trail.trail_id, { ...trail, status: 'open', reason: null, updated_ms: nowMs });
  }
  for (const counter of SEED.counters) {
    store.counters.set(counter.counter_id, { ...counter, last_heartbeat_ms: nowMs });
  }
  bump(store, 'seed', 'topography', nowMs);
}
