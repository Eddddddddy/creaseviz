import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/** Results are read-only: defer charts/tables until requested, unlike editable settings. */
export default function AssessmentResultDetails({ title, hint, children }: {
  title: string; hint: string; children: () => ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  return <details className="assessment-result-details" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary aria-label={title}><ChevronRight size={16} aria-hidden="true" /><strong>{title}</strong><span>{hint}</span></summary>
    {expanded ? <div className="assessment-result-details-content">{children()}</div> : null}
  </details>
}
