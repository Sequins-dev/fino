/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { Text, Bold, Italic, InlineCode } from 'fino:ui/components';
import { layoutFrame } from 'fino:tty/tui';
import { lowerTui } from 'internal:tty/lower';

describe('inline styling inside Text', () => {
  it('keeps nested emphasis as its own styled run', (t) => {
    const frame = layoutFrame(
      lowerTui(
        <Text>
          plain <Bold>loud</Bold> and <Italic>slanted</Italic>
        </Text>,
      ),
      { width: 40, height: 1 },
    );
    const row = frame.rows[0]!;
    const text = row.segments.map((s) => s.text).join('');
    t.equal(text, 'plain loud and slanted', 'all text present in order');
    const bold = row.segments.find((s) => s.text.includes('loud'));
    t.equal(bold?.style.bold, true, 'nested Bold keeps its weight');
    const italic = row.segments.find((s) => s.text.includes('slanted'));
    t.equal(italic?.style.italic, true, 'nested Italic keeps its slant');
    const plain = row.segments.find((s) => s.text.startsWith('plain'));
    t.ok(!plain?.style.bold && !plain?.style.italic, 'surrounding text stays unstyled');
  });

  it('inherits outer style into nested runs', (t) => {
    const frame = layoutFrame(
      lowerTui(
        <Text dim>
          muted <Bold>but loud</Bold>
        </Text>,
      ),
      { width: 40, height: 1 },
    );
    const loud = frame.rows[0]!.segments.find((s) => s.text.includes('loud'));
    t.equal(loud?.style.dim, true, 'outer dim inherits');
    t.equal(loud?.style.bold, true, 'inner bold applies too');
  });

  it('renders inline code inside a sentence', (t) => {
    const frame = layoutFrame(
      lowerTui(
        <Text>
          run <InlineCode>fino test</InlineCode> now
        </Text>,
      ),
      { width: 40, height: 1 },
    );
    t.equal(
      frame.rows[0]!.segments.map((s) => s.text).join(''),
      'run fino test now',
      'inline code composes in a sentence',
    );
  });
});
