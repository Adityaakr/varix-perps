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
        background: { type: ColorType.Solid, color: "#11181d" },
        textColor: "#7f8b93"
      },
      grid: {
        vertLines: { color: "rgba(127, 139, 147, 0.07)" },
        horzLines: { color: "rgba(127, 139, 147, 0.07)" }
      },
      rightPriceScale: {
        borderColor: "rgba(127, 139, 147, 0.10)"
      },
      timeScale: {
        borderColor: "rgba(127, 139, 147, 0.10)"
      },
      crosshair: {
        vertLine: { color: "rgba(133, 239, 207, 0.25)" },
        horzLine: { color: "rgba(133, 239, 207, 0.2)" }
      }
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#6ed0c2",
      downColor: "#e06b6d",
      borderVisible: false,
      wickUpColor: "#6ed0c2",
      wickDownColor: "#e06b6d"
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
          <span>Hyperliquid</span>
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
