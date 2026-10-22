'use client';

import { useEffect, useRef } from 'react';
import { CandlestickSeries, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candles } from '@/lib/api';
import { formatNumber } from '../explore/format';

/** Memecoin prices run to 1e-9 and below: subscript-zero form (0.0₈17) keeps them short and readable. */
export function formatPrice(p: number): string {
  return formatNumber(p, { maxDecimals: 4 });
}

/**
 * lightweight-charts' tick maths breaks on prices this small (minMove below ~1e-15 throws "unexpected
 * base"), so the series is plotted scaled by a power of ten into roughly 1–1000 and the axis formatter
 * divides it back out. Labels always show the real price.
 */
export function priceScaleFactor(data: { high: number }[]): number {
  const max = Math.max(0, ...data.map((d) => d.high));
  if (max <= 0 || max >= 1) return 1;
  return 10 ** Math.ceil(-Math.log10(max));
}

/**
 * lightweight-charts draws every time in UTC. Shifting each timestamp by the viewer's UTC offset (its own
 * documented approach) makes the axis, the crosshair and the day boundaries read in local time. The offset is
 * taken per timestamp, so a daylight-saving change mid-chart stays right.
 */
const toLocal = (t: number) => (t - new Date(t * 1000).getTimezoneOffset() * 60) as UTCTimestamp;

/** Opening zoom: narrow candles from the latest one back, rather than the few there are stretched to fill the width. */
const BAR_SPACING = 4;
const RIGHT_OFFSET = 3;

/**
 * Candles in the pair asset (docs/BRIEF.md §5.4): white plot, grey grid, Inter 12 px, 180 px tall,
 * with volume as a faint histogram along the bottom. Remount it (key) when the interval changes.
 */
export function PriceChart({ data }: { data: Candles['candles'] }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const scale = useRef(1);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { color: '#ffffff' },
        textColor: '#6a6a70',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
        fontSize: 12,
      },
      grid: { vertLines: { color: '#eeeeee' }, horzLines: { color: '#eeeeee' } },
      rightPriceScale: { borderColor: 'rgba(0, 0, 0, 0.1)' },
      timeScale: { borderColor: 'rgba(0, 0, 0, 0.1)', timeVisible: true, secondsVisible: false, barSpacing: BAR_SPACING, rightOffset: RIGHT_OFFSET },
      crosshair: { mode: 0 },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: '#4a8c25',
      downColor: '#c91f00',
      wickUpColor: '#4a8c25',
      wickDownColor: '#c91f00',
      borderVisible: false,
      priceFormat: { type: 'custom', formatter: (p: number) => formatPrice(p / scale.current), minMove: 1e-6 },
    });
    volume.current = c.addSeries(HistogramSeries, {
      priceScaleId: '',
      color: 'rgba(10, 98, 224, 0.25)',
      priceFormat: { type: 'volume' },
      // Volume shares the price axis's edge; its own value tag there would read as a price.
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.current.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, []);

  // The parent remounts the chart per interval; set the opening view once, then leave the user's zoom alone on refreshes.
  const fitted = useRef(false);
  useEffect(() => {
    if (!candles.current || !volume.current) return;
    // Fixed after the first data so a refresh can't rescale the axis under the user.
    if (!fitted.current) scale.current = priceScaleFactor(data);
    const k = scale.current;
    candles.current.setData(data.map((d) => ({ time: toLocal(d.time), open: d.open * k, high: d.high * k, low: d.low * k, close: d.close * k })));
    volume.current.setData(
      data.map((d) => ({ time: toLocal(d.time), value: d.volume, color: d.close >= d.open ? 'rgba(74, 140, 37, 0.3)' : 'rgba(201, 31, 0, 0.3)' })),
    );
    if (!fitted.current && data.length) {
      chart.current?.timeScale().scrollToRealTime();
      fitted.current = true;
    }
  }, [data]);

  return <div ref={el} style={{ height: 180, width: '100%' }} />;
}
