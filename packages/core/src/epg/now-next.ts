import type { EpgProgram, NowNext } from '../models/epg';

const toMillis = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const getNowNext = (
  programs: EpgProgram[],
  nowDate: Date = new Date()
): Map<string, NowNext> => {
  const nowMs = nowDate.getTime();
  const sorted = [...programs].sort((left, right) => toMillis(left.start) - toMillis(right.start));

  const result = new Map<string, NowNext>();

  for (const program of sorted) {
    const start = toMillis(program.start);
    const end = toMillis(program.end);

    const current = result.get(program.channelTvgId) ?? { channelTvgId: program.channelTvgId };

    if (!current.now && start <= nowMs && end > nowMs) {
      current.now = program;
      result.set(program.channelTvgId, current);
      continue;
    }

    if (current.now && !current.next && start >= toMillis(current.now.end)) {
      current.next = program;
      result.set(program.channelTvgId, current);
    }
  }

  return result;
};

export const filterProgramsByDay = (programs: EpgProgram[], day: string): EpgProgram[] => {
  const dayStart = new Date(`${day}T00:00:00.000Z`).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  return programs.filter((program) => {
    const start = toMillis(program.start);
    const end = toMillis(program.end);
    return end > dayStart && start < dayEnd;
  });
};
