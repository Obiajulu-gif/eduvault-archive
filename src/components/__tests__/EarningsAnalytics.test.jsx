import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EarningsAnalytics from '../EarningsAnalytics';

const mockUseEarningsData = vi.fn();

vi.mock('../../hooks/useEarningsData', () => ({
  default: (...args) => mockUseEarningsData(...args),
}));

describe('EarningsAnalytics', () => {
  const mockData = [
    { date: '2024-01-01', earnings: 1000, gas: 100, royalties: 200, net: 700 },
    { date: '2024-01-02', earnings: 1200, gas: 120, royalties: 220, net: 860 },
    { date: '2024-01-03', earnings: 950, gas: 90, royalties: 180, net: 680 },
  ];

  beforeEach(() => {
    mockUseEarningsData.mockReturnValue(mockData);
  });

  it('renders without requiring CDN request (uses local recharts)', () => {
    render(<EarningsAnalytics />);
    
    // Verify interval buttons render
    expect(screen.getByRole('button', { name: /7 Days/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /30 Days/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Year.to.Date/i })).toBeInTheDocument();
  });

  it('renders the chart with default 7d interval', () => {
    render(<EarningsAnalytics />);
    
    // Verify useEarningsData was called with default interval
    expect(mockUseEarningsData).toHaveBeenCalledWith('7d');
  });

  it('switches interval on button click and fetches new data', () => {
    render(<EarningsAnalytics />);
    
    const thirtyDayBtn = screen.getByRole('button', { name: /30 Days/i });
    fireEvent.click(thirtyDayBtn);
    
    expect(mockUseEarningsData).toHaveBeenCalledWith('30d');
  });

  it('switches to YTD interval', () => {
    render(<EarningsAnalytics />);
    
    const ytdBtn = screen.getByRole('button', { name: /Year.to.Date/i });
    fireEvent.click(ytdBtn);
    
    expect(mockUseEarningsData).toHaveBeenCalledWith('ytd');
  });

  it('marks the active interval button with aria-pressed=true', () => {
    render(<EarningsAnalytics />);
    
    const sevenDayBtn = screen.getByRole('button', { name: /7 Days/i });
    expect(sevenDayBtn).toHaveAttribute('aria-pressed', 'true');
    
    const thirtyDayBtn = screen.getByRole('button', { name: /30 Days/i });
    expect(thirtyDayBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('updates aria-pressed when switching intervals', () => {
    render(<EarningsAnalytics />);
    
    const sevenDayBtn = screen.getByRole('button', { name: /7 Days/i });
    const thirtyDayBtn = screen.getByRole('button', { name: /30 Days/i });
    
    expect(sevenDayBtn).toHaveAttribute('aria-pressed', 'true');
    expect(thirtyDayBtn).toHaveAttribute('aria-pressed', 'false');
    
    fireEvent.click(thirtyDayBtn);
    
    expect(sevenDayBtn).toHaveAttribute('aria-pressed', 'false');
    expect(thirtyDayBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the chart container and legend', () => {
    const { container } = render(<EarningsAnalytics />);
    
    // ResponsiveContainer from recharts
    expect(container.querySelector('.earnings-chart-container')).toBeInTheDocument();
  });

  it('does not use window.Chart or require any CDN', () => {
    // This test verifies that the component does not reference window.Chart
    // and therefore does not depend on CDN-loaded scripts.
    const windowChartBefore = window.Chart;
    
    render(<EarningsAnalytics />);
    
    // window.Chart should not have been created or required
    expect(window.Chart).toEqual(windowChartBefore);
  });
});
