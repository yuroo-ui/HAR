import { createTheme, type MantineColorsTuple } from '@mantine/core';

// Blue accent matching the existing --accent (#3b82f6) palette.
const brand: MantineColorsTuple = [
  '#eef4ff',
  '#dbe6fe',
  '#b6cbfc',
  '#8eaefb',
  '#6d96f9',
  '#5a87f9',
  '#3b82f6',
  '#2f6fe0',
  '#2563eb',
  '#1d4ed8',
];

export const theme = createTheme({
  primaryColor: 'brand',
  colors: { brand },
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, sans-serif',
  fontFamilyMonospace: 'ui-monospace, Menlo, "SF Mono", monospace',
  defaultRadius: 'md',
  cursorType: 'pointer',
  components: {
    // Keep controls compact to match the dense devtools layout.
    Button: { defaultProps: { size: 'xs' } },
    TextInput: { defaultProps: { size: 'xs' } },
    Select: { defaultProps: { size: 'xs' } },
    ActionIcon: { defaultProps: { size: 'lg', variant: 'subtle' } },
    SegmentedControl: { defaultProps: { size: 'xs' } },
    Modal: { defaultProps: { centered: true, radius: 'md' } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 300 } },
  },
});
