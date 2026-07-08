/**
 * 우측 패널 (7.1.3) — [인스펙터 | ✦ AI] 탭.
 * 두 패널 모두 항상 마운트하고 display 로만 전환 → AI 패널이 탭 뒤에서도 이벤트를 계속 수신한다.
 */
import { useState } from 'react'
import { Inspector } from './Inspector'
import { AiPanel } from './AiPanel'

export function RightPanel(): React.JSX.Element {
  const [tab, setTab] = useState<'inspector' | 'ai'>('inspector')
  return (
    <div className="right-panel">
      <div className="right-tabs">
        <button className={tab === 'inspector' ? 'active' : ''} onClick={() => setTab('inspector')}>
          인스펙터
        </button>
        <button className={tab === 'ai' ? 'active' : ''} data-testid="ai-tab" onClick={() => setTab('ai')}>
          ✦ AI
        </button>
      </div>
      <div className="right-body">
        <div className="right-pane" style={{ display: tab === 'inspector' ? 'block' : 'none' }}>
          <Inspector />
        </div>
        <div className="right-pane" style={{ display: tab === 'ai' ? 'flex' : 'none' }}>
          <AiPanel active={tab === 'ai'} />
        </div>
      </div>
    </div>
  )
}
