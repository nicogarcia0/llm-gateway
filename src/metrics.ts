/** Minimal Prometheus text-format exporter (counters + caller-supplied gauges). */
export class Metrics {
  private counters = new Map<string, number>();

  inc(name: string, labels: Record<string, string | number> = {}, by = 1) {
    const l = Object.entries(labels)
      .map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, "_")}"`)
      .join(",");
    const key = l ? `${name}{${l}}` : name;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  render(gauges: Record<string, number> = {}): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const [key, value] of [...this.counters].sort()) {
      const base = key.split("{")[0];
      if (!seen.has(base)) {
        lines.push(`# TYPE ${base} counter`);
        seen.add(base);
      }
      lines.push(`${key} ${value}`);
    }
    for (const [key, value] of Object.entries(gauges).sort()) {
      const base = key.split("{")[0];
      if (!seen.has(base)) {
        lines.push(`# TYPE ${base} gauge`);
        seen.add(base);
      }
      lines.push(`${key} ${value}`);
    }
    return lines.join("\n") + "\n";
  }
}
