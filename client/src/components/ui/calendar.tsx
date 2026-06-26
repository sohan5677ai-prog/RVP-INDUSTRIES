import 'react-day-picker/style.css';
import { DayPicker } from 'react-day-picker';
import { cn } from '@/lib/utils';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

/** Theme-styled month calendar (react-day-picker). Amber selection, serif caption. */
export function Calendar({ className, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('rdp-premium', className)}
      {...props}
    />
  );
}
