import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

interface Props {
  label: string
  hint?: string
  children: ReactNode
}

/** Native disclosure keeps controls mounted and values intact while collapsed. */
export default function AdvancedSettings({ label, hint, children }: Props) {
  return <details className="advanced-settings">
    <summary aria-label={label}>
      <ChevronRight size={14} aria-hidden="true" />
      <span>高级设置</span>
      {hint ? <small>{hint}</small> : null}
    </summary>
    <div className="advanced-settings-content">{children}</div>
  </details>
}
