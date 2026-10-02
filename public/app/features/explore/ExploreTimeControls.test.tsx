import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { getDefaultTimeRange } from '@grafana/data';
import { config } from '@grafana/runtime';

import { ExploreTimeControls, Props } from './ExploreTimeControls';

const defaultProps: Props = {
  exploreId: 'left',
  range: getDefaultTimeRange(),
  timeZone: 'browser',
  fiscalYearStartMonth: 0,
  splitted: false,
  syncedTimes: false,
  onChangeTimeSync: jest.fn(),
  onChangeTime: jest.fn(),
  onChangeTimeZone: jest.fn(),
  onChangeFiscalYearStartMonth: jest.fn(),
};

describe('ExploreTimeControls', () => {
  const originalQuickRanges = config.quickRanges;

  afterEach(() => {
    config.quickRanges = originalQuickRanges;
  });

  it('renders time picker and passes configured quickRanges from config', async () => {
    config.quickRanges = [
      { from: 'now-1h', to: 'now', display: 'Last 1 hour' },
      { from: 'now-24h', to: 'now', display: 'Last 24 hours' },
    ];

    render(<ExploreTimeControls {...defaultProps} />);

    // Click time picker button to open dropdown
    await userEvent.click(screen.getByLabelText(/Time range selected/));

    // Custom quick ranges from config should be displayed
    expect(screen.getByRole('checkbox', { name: 'Last 1 hour' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Last 24 hours' })).toBeInTheDocument();
    // Default ranges not in quickRanges should not be displayed
    expect(screen.queryByRole('checkbox', { name: 'Last 5 minutes' })).not.toBeInTheDocument();
  });
});
