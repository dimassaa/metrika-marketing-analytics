import { describe, expect, it } from 'vitest';
import { buildScoreStack, scoreStackCaption } from '../../client/components/charts/ScoreStack.jsx';

/**
 * @param {object} overrides
 * @returns {object} A visible ranked row with a complete four-segment stack.
 */
function row(overrides) {
  return {
    channelId: 'x',
    name: 'Channel',
    rank: 2,
    score: 50,
    stack: [
      { criterion: 'cac', label: 'CAC', value: 15, scored: 1, weight: 0.3 },
      { criterion: 'romi', label: 'ROMI', value: 15, scored: 0.5, weight: 0.3 },
      { criterion: 'ltvCac', label: 'LTV:CAC', value: 12.5, scored: 0.5, weight: 0.25 },
      { criterion: 'newCustomers', label: 'Новые клиенты', value: 7.5, scored: 0.5, weight: 0.15 },
    ],
    ...overrides,
  };
}

describe('score stack caption', () => {
  it('derives the best visible bar when the rank-1 channel is filtered out', () => {
    // The rank-1 channel is not in `rows`: this is what the page passes after a status/kind filter hides it.
    const rows = [
      row({ channelId: '3', name: 'Gamma', rank: 3, score: 42 }),
      row({ channelId: '2', name: 'Beta', rank: 2, score: 68 }),
    ];

    const stack = buildScoreStack(rows);
    const caption = scoreStackCaption(stack);

    expect(stack.series).toHaveLength(2);
    expect(stack.best).toMatchObject({ channelId: '2', name: 'Beta', score: 68 });
    expect(caption).toContain('Beta');
    expect(caption).not.toContain('Ни один канал');
  });

  it('says no scores only when the chart has no bar at all', () => {
    expect(scoreStackCaption({ series: [], best: null })).toContain('Ни один канал не получил оценку');
  });
});
