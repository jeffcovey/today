import { interpolateTemplate } from '../src/template-interpolation.js';

describe('interpolateTemplate', () => {
  test('treats replacement patterns in values literally', () => {
    const template = '<main>{{content}}</main><footer>{{footer}}</footer>';
    const result = interpolateTemplate(template, {
      content: '<p>$& $1 $$</p>',
      footer: '$` $\'',
    });

    expect(result).toBe('<main><p>$& $1 $$</p></main><footer>$` $\'</footer>');
  });
});
