export const RAIN_STEP = 15;
export const HORIZON = 360;
export const MAX_RAIN_BINS = HORIZON / RAIN_STEP;
export const MM_PER_INCH = 25.4;

export function bounded(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

export function compositeCN(perviousCN, percent) {
  bounded(perviousCN, 1, 98, 'Pervious curve number');
  bounded(percent, 0, 100, 'Connected impervious cover');
  return perviousCN + (98 - perviousCN) * percent / 100;
}

export function partitionRain(rain, cn) {
  bounded(rain, 0, Number.MAX_VALUE, 'Rainfall');
  const retention = (1000 / bounded(cn, 1, 100, 'Curve number') - 10) * MM_PER_INCH;
  const ia = 0.2 * retention;
  const abstraction = Math.min(rain, ia);
  const excess = rain - abstraction;
  const storage = excess === 0 || retention === 0 ? 0 : retention * (excess / (excess + retention));
  const runoff = excess === 0 || retention === 0 ? excess : excess * (excess / (excess + retention));
  return { rain, retention, ia, abstraction, storage, runoff, residual: rain - (abstraction + storage + runoff) };
}

export function rainSeries(rain, cn) {
  if (!Array.isArray(rain) || rain.length === 0 || rain.length > MAX_RAIN_BINS) {
    throw new RangeError(`Enter 1 to ${MAX_RAIN_BINS} rainfall depths.`);
  }
  let total = 0;
  let prior = 0;
  return Array.from(rain, (mm, index) => {
    total += bounded(mm, 0, 5000, `Rainfall bin ${index + 1}`);
    const budget = partitionRain(total, cn);
    const runoffIncrement = budget.runoff - prior;
    prior = budget.runoff;
    return { minute: (index + 1) * RAIN_STEP, mm, runoffIncrement, ...budget };
  });
}

export function parseRain(input) {
  const items = input.trim().split(/[\s,]+/);
  if (!input.trim() || /^\s*,|,\s*$|,\s*,/.test(input) ||
      items.some(item => !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(item))) {
    throw new RangeError('Use nonnegative millimeter values separated by spaces or commas.');
  }
  const rain = items.map(Number);
  rainSeries(rain, 100);
  return rain;
}

// A unit-volume triangle. Integer knots make minute-grid trapezoids integrate the signal exactly.
export function triangle(minutes, peak, end) {
  if (!Number.isInteger(peak) || !Number.isInteger(end) || peak <= 0 || end <= peak || end > 720) {
    throw new RangeError('Triangle needs integer times with 0 < peak < end <= 720.');
  }
  if (minutes <= 0 || minutes >= end) return 0;
  const shape = minutes <= peak ? minutes / peak : (end - minutes) / (end - peak);
  return shape * 2 / (end * 60);
}

export function rainToDischarge(bins, areaKm2, peak, end) {
  bounded(areaKm2, 0.001, 1000, 'Watershed area');
  triangle(peak, peak, end);
  const q = new Float64Array(Math.max(HORIZON, bins.at(-1).minute + end) + 1);
  const kernel = Array.from({ length: end }, (_, i) => triangle(i, peak, end));
  for (const { minute, runoffIncrement } of bins) {
    const volume = runoffIncrement * areaKm2 * 1000;
    for (let lag = 1; lag < end; lag += 1) q[minute + lag] += volume * kernel[lag];
  }
  return q;
}

export function integrateDischarge(q) {
  let volume = 0;
  for (let i = 1; i < q.length; i += 1) volume += (q[i - 1] + q[i]) * 30;
  return volume;
}

export function normalDepthDischarge(depth, channel) {
  const { width, sideSlope, n, slope } = channel;
  bounded(depth, 0, 1e6, 'Depth');
  bounded(width, 0.01, 1e4, 'Bottom width');
  bounded(sideSlope, 0, 20, 'Side slope');
  bounded(n, 0.001, 2, 'Manning n');
  bounded(slope, 0, 1, 'Bed slope');
  if (depth === 0 || slope === 0) return 0;
  const area = depth * (width + sideSlope * depth);
  const wetted = width + 2 * depth * Math.hypot(1, sideSlope);
  return area * (area / wetted) ** (2 / 3) * Math.sqrt(slope) / n;
}

export function solveStage(target, channel) {
  bounded(target, 0, Number.MAX_VALUE, 'Discharge');
  normalDepthDischarge(0, channel);
  if (target === 0) return 0;
  if (channel.slope === 0) throw new RangeError('Zero-slope Manning flow cannot carry positive discharge.');
  let low = 0;
  let high = 1;
  while (normalDepthDischarge(high, channel) < target) {
    if (high === 1e6) throw new RangeError('Discharge exceeds the modeled channel depth range.');
    high = Math.min(1e6, high * 2);
  }
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    if (mid === low || mid === high) break;
    const q = normalDepthDischarge(mid, channel);
    if (q === target) return mid;
    if (q < target) low = mid;
    else high = mid;
  }
  return target - normalDepthDischarge(low, channel) < normalDepthDischarge(high, channel) - target ? low : high;
}

export function sampleDischarge(q, minute) {
  bounded(minute, 0, q.length - 1, 'Minute');
  const a = Math.floor(minute);
  return q[a] + (q[Math.ceil(minute)] - q[a]) * (minute - a);
}

// Return the boundary of the first interval strictly above the threshold, not the next integer tick.
export function firstAbove(q, threshold, start = 0, end = q.length - 1) {
  bounded(threshold, 0, Number.MAX_VALUE, 'Discharge threshold');
  const initial = sampleDischarge(q, start);
  if (end < start) throw new RangeError('End minute precedes start minute.');
  sampleDischarge(q, end);
  if (initial > threshold) return start;
  let left = start;
  let prior = initial;
  for (let right = Math.floor(start) + 1; left < end; right += 1) {
    const next = Math.min(right, end);
    const value = sampleDischarge(q, next);
    if (value > threshold) return left + (next - left) * ((threshold - prior) / (value - prior));
    left = next;
    prior = value;
  }
  return null;
}

export function simulate({ rain, cn, areaKm2, peakLag, endLag, channel, blockage }) {
  const bins = rainSeries(rain, cn);
  bounded(blockage, 0, 1, 'Blockage');
  bounded(channel.bankfull, 0.01, 100, 'Bankfull depth');
  const effective = { ...channel, n: channel.n * (1 + blockage) };
  const q = rainToDischarge(bins, areaKm2, peakLag, endLag);
  const stage = q.map(value => solveStage(value, effective));
  let peakMinute = 0;
  for (let i = 1; i < q.length; i += 1) if (q[i] > q[peakMinute]) peakMinute = i;
  const bankfullQ = normalDepthDischarge(effective.bankfull, effective);
  const volume = bins.at(-1).runoff * areaKm2 * 1000;
  const discharged = integrateDischarge(q);
  return {
    q, stage, bins, channel: effective, peakMinute, peakQ: q[peakMinute], peakStage: stage[peakMinute],
    bankfullQ, firstOverbank: firstAbove(q, bankfullQ), volume, discharged,
    residual: discharged - volume,
    maxRainResidual: Math.max(...bins.map(bin => Math.abs(bin.residual))),
  };
}
