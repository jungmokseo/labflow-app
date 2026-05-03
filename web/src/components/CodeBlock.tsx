'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

// SyntaxHighlighter는 ~200KB. dynamic import로 코드 블록이 처음 렌더될 때만 로드.
const SyntaxHighlighter = dynamic(
  () => import('react-syntax-highlighter').then((mod) => mod.default),
  {
    ssr: false,
    loading: () => (
      <pre className="m-0 px-4 py-3 text-sm font-mono text-text-main bg-[#1a1b26] overflow-x-auto">
        <code>{''}</code>
      </pre>
    ),
  },
);

// hljs 스타일도 분리 로드 (lazy)
let cachedStyle: any = null;
function useHljsStyle() {
  const [style, setStyle] = useState<any>(cachedStyle);
  if (!style && typeof window !== 'undefined') {
    import('react-syntax-highlighter/dist/esm/styles/hljs').then((mod) => {
      cachedStyle = mod.atomOneDark;
      setStyle(mod.atomOneDark);
    });
  }
  return style;
}

function CodeCopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(content).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }).catch(() => {});
      }}
      className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-muted hover:text-text-heading hover:bg-bg-hover/50 transition-colors"
    >
      {copied ? (
        <><Check className="w-3 h-3 text-green-400" /><span className="text-green-400">복사됨</span></>
      ) : (
        <><Copy className="w-3 h-3" />복사</>
      )}
    </button>
  );
}

interface CodeBlockProps {
  language: string;
  code: string;
}

export function CodeBlock({ language, code }: CodeBlockProps) {
  const style = useHljsStyle();

  return (
    <div className="code-block-wrapper my-3 rounded-lg overflow-hidden border border-[#414868]">
      <div className="flex items-center justify-between bg-[#24283b] px-3 py-1.5 border-b border-[#414868]">
        <span className="text-xs font-mono text-[#7aa2f7]">{language || 'code'}</span>
        <CodeCopyButton content={code} />
      </div>
      {style ? (
        <SyntaxHighlighter
          language={language || 'text'}
          style={style}
          customStyle={{
            margin: 0,
            borderRadius: 0,
            fontSize: '0.8125rem',
            lineHeight: '1.7',
            padding: '1rem',
            background: '#1a1b26',
          }}
          wrapLongLines={false}
        >
          {code}
        </SyntaxHighlighter>
      ) : (
        // 스타일 로드 전 대체 표시 — flash 방지
        <pre className="m-0 px-4 py-4 text-[13px] font-mono text-text-main bg-[#1a1b26] overflow-x-auto leading-[1.7]">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
