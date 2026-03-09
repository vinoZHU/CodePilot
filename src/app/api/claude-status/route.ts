import { NextResponse } from 'next/server';
import { findClaudeBinary, getClaudeVersion } from '@/lib/platform';

export async function GET() {
  try {
    const claudePath = findClaudeBinary();
    if (!claudePath) {
      return NextResponse.json({ connected: false, version: null });
    }
    // findClaudeBinary() 内部已通过 --version 验证 CLI 存在，不重复调用
    // getClaudeVersion 仅用于获取版本号显示，其失败不影响 connected 判断
    const version = await getClaudeVersion(claudePath).catch(() => null);
    return NextResponse.json({ connected: true, version });
  } catch {
    return NextResponse.json({ connected: false, version: null });
  }
}
