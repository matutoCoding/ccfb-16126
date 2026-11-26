import type { ClientRecord, ScanRecord, ScanVariant } from './types';
import { generateImpression } from './geom/procedural';
import { writeBinarySTL } from './geom/stl';
import { db, uid } from './db';

export function defaultAudiogram() {
  return {
    frequencies: [125, 250, 500, 1000, 2000, 4000, 8000],
    left: [25, 30, 35, 45, 55, 65, 70],
    right: [20, 25, 30, 40, 50, 60, 65]
  };
}

export async function seedScansIfNeeded(): Promise<ScanRecord[]> {
  const existing = await db.scans.all();
  if (existing.length) return existing.sort((a, b) => a.createdAt - b.createdAt);

  const variants: Array<{ variant: ScanVariant; name: string }> = [
    { variant: 'normal', name: '测试耳模 A · 正常耳道' },
    { variant: 'narrow', name: '测试耳模 B · 耳道特别窄' },
    { variant: 'sharp-bend', name: '测试耳模 C · 第二弯很急' },
    { variant: 'bubble-damage', name: '测试耳模 D · 气泡缺损' }
  ];
  const now = Date.now();
  const scans: ScanRecord[] = [];
  for (let i = 0; i < variants.length; i++) {
    const g = generateImpression(variants[i].variant);
    const stlBlob = writeBinarySTL(g.mesh, variants[i].variant);
    const scan: ScanRecord = {
      id: `scan-${variants[i].variant}`,
      name: variants[i].name,
      variant: variants[i].variant,
      createdAt: now + i,
      mesh: g.mesh,
      landmarks: g.landmarks,
      defects: g.defects,
      centerline: g.centerline,
      stl: await stlBlob.arrayBuffer()
    };
    await db.scans.save(scan);
    scans.push(scan);
  }

  const client: ClientRecord = {
    id: 'client-demo-elder',
    name: '张桂兰（示例）',
    phone: '138****0618',
    age: 78,
    createdAt: now,
    updatedAt: now,
    left: {
      side: 'left', audiogram: defaultAudiogram(), deviceModel: 'Audeo L50 · 受话器外置式',
      moldType: 'full-concha', orderIds: [], note: '左耳道略窄，老人反映佩戴胀。'
    },
    right: {
      side: 'right', audiogram: defaultAudiogram(), deviceModel: '定制 CIC · 10A 电池',
      moldType: 'deep-canal', orderIds: [], note: '第二次返工：第二弯处顶痛。'
    },
    history: [
      { id: uid('h'), date: now - 86400000 * 35, side: 'right', version: 1, issue: '出声孔被耵聍堵死', note: '旧壳声管出口需要加防护' },
      { id: uid('h'), date: now - 86400000 * 6, side: 'right', version: 2, issue: '塞不进去，耳道第二弯顶得疼', note: '工厂修壳后未过弯检查' }
    ]
  };
  await db.clients.save(client);
  return scans;
}
