import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button, Status } from '../../src/components/ui';

describe('UI部品', () => {
  it('押せないボタンは理由を隣に表示する（opacityだけにしない）', () => {
    render(<Button disabledReason="理由を入力してください">保存</Button>);
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(screen.getByText('押せない理由：理由を入力してください')).toBeInTheDocument();
  });
  it('状態は色だけでなく文言で示す', () => {
    render(<Status tone="warning">2脚が未返却です</Status>);
    expect(screen.getByText('2脚が未返却です')).toBeInTheDocument();
  });
});
