import { cn } from "@/lib/utils";

export type Stat = {
  num: string;
  label: string;
};

export function StatsStrip({ stats, className }: { stats: Stat[]; className?: string }) {
  return (
    <div className={cn("stats-strip", className)}>
      {stats.map((s) => (
        <div className="stat" key={s.label}>
          <div className="num" dangerouslySetInnerHTML={{ __html: s.num }} />
          <div className="lbl">{s.label}</div>
        </div>
      ))}
    </div>
  );
}
