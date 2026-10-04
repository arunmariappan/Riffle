/** The controls guide (plan 9), shown in the settings dialog and mirrored in the README. */
export const CONTROLS: { mode: string; keys: [string, string][] }[] = [
  {
    mode: 'Explore',
    keys: [
      ['Click', 'Look around (Esc releases the mouse)'],
      ['W A S D', 'Walk'],
      ['Shift', 'Run'],
      ['Space', 'Jump; swim up'],
      ['C', 'Sink while swimming'],
      ['F', 'Throw food onto the water ahead'],
      ['E', 'Look at the fish in the middle of the view'],
      ['Tab', 'Build'],
      ['P', 'Photo mode'],
    ],
  },
  {
    mode: 'Build',
    keys: [
      ['Right-drag', 'Turn the view'],
      ['Middle-drag, Shift + right-drag', 'Pan'],
      ['Wheel', 'Zoom'],
      ['W A S D, Q E', 'Pan, turn'],
      ['Drag a card', 'Place it (wheel turns it, Shift + wheel scales it)'],
      ['Click', 'Select; Shift + click adds to the selection'],
      ['1 2 3', 'Move, turn, scale the selection'],
      ['Delete', 'Remove the selection'],
      ['Ctrl + Z, Ctrl + Shift + Z', 'Undo, redo'],
      ['Tab', 'Explore from here'],
    ],
  },
  {
    mode: 'Photo',
    keys: [
      ['Right-drag', 'Look around'],
      ['W A S D, Q E', 'Move, down and up (Shift: faster)'],
      ['Wheel', 'Zoom (focal length)'],
      ['Click', 'Focus there'],
      ['H', 'Hide the controls'],
      ['Esc', 'Back to exploring'],
    ],
  },
];
