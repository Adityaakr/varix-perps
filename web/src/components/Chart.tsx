import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from "lightweight-charts";
import type { Candle } from "../types";
import { formatMoney } from "../lib/format";

type ChartProps = {
  asset: string;
  candles: Candle[];
  intervalLabel?: string;
  onIntervalChange?: (interval: "5m" | "1h" | "1d") => void;
};

export function Chart({ asset, candles, intervalLabel = "1h", onIntervalChange }: ChartProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastCandle = candles.at(-1);

  useEffect(() => {
    if (!rootRef.current) {
      return;
    }

    const root = rootRef.current;
    const chart = createChart(root, {
      autoSize: false,
      layout: {
        background: { type: ColorType.Solid, color: "#090812" },
        textColor: "#8b84a3"
      },
      grid: {
        vertLines: { color: "rgba(255, 255, 255, 0.03)" },
        horzLines: { color: "rgba(255, 255, 255, 0.03)" }
      },
      rightPriceScale: {
        borderColor: "rgba(255, 255, 255, 0.06)"
      },
      timeScale: {
        borderColor: "rgba(255, 255, 255, 0.06)"
      },
      crosshair: {
        vertLine: { color: "rgba(168, 85, 247, 0.25)" },
        horzLine: { color: "rgba(168, 85, 247, 0.2)" }
      }
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444"
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const resize = () => {
      if (!rootRef.current || !chartRef.current) {
        return;
      }
      chartRef.current.resize(rootRef.current.clientWidth, rootRef.current.clientHeight);
    };

    resize();
    const observer = new ResizeObserver(() => resize());
    observer.observe(root);

    return () => {
      observer.disconnect();
      seriesRef.current = null;
      chartRef.current?.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }

    seriesRef.current.setData(
      candles.map((item) => ({
        time: Math.floor(item.t / 1000) as UTCTimestamp,
        open: item.o,
        high: item.h,
        low: item.l,
        close: item.c
      }))
    );

    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return (
    <section className="chart-panel">
      <div className="chart-header">
        <div className="chart-tabs">
          <button className={`chart-tab ${intervalLabel === "5m" ? "is-active" : ""}`} onClick={() => onIntervalChange?.("5m")} type="button">5m</button>
          <button className={`chart-tab ${intervalLabel === "1h" ? "is-active" : ""}`} onClick={() => onIntervalChange?.("1h")} type="button">1h</button>
          <button className={`chart-tab ${intervalLabel === "1d" ? "is-active" : ""}`} onClick={() => onIntervalChange?.("1d")} type="button">D</button>
          <button className="chart-tab" type="button">Indicators</button>
        </div>
        <div className="chart-tools">
          <span>{intervalLabel}</span>
          <span>Live Feed</span>
        </div>
      </div>
      <div className="chart-titlebar">
        <h2>{asset}USD · {intervalLabel} · Varix</h2>
        {lastCandle ? (
          <div className="chart-ohlc">
            <span>O {formatMoney(lastCandle.o, 1)}</span>
            <span>H {formatMoney(lastCandle.h, 1)}</span>
            <span>L {formatMoney(lastCandle.l, 1)}</span>
            <span className={lastCandle.c >= lastCandle.o ? "positive" : "negative"}>
              C {formatMoney(lastCandle.c, 1)}
            </span>
          </div>
        ) : null}
      </div>
      <div className="chart-shell">
        <div className="chart-sidebar" aria-hidden="true">
          <span>+</span>
          <span>/</span>
          <span>◫</span>
          <span>⌖</span>
          <span>⌁</span>
        </div>
        <div className="chart-root" ref={rootRef} />
      </div>
    </section>
  );
}
