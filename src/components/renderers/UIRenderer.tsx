import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

// ─── Action Context (for ActionCard clicks) ───

type ActionHandler = (prompt: string) => void
const ActionContext = createContext<ActionHandler | null>(null)

// Quiz frames need to know which explanation row they belong to so the
// answer mutation can scope ownership. The renderer is generic for all UI
// configs, so we pass this through React context rather than as a prop on
// every Quiz subnode.
const QuizExplanationContext = createContext<Id<'explanations'> | null>(null)

// ─── Types ───

type JsonNode = {
  component: string
  props?: Record<string, any>
  children?: JsonNode[] | string
}

// ─── Component Map ───

function renderChildren(children: JsonNode[] | string | undefined): ReactNode {
  if (!children) return null
  if (typeof children === 'string') return children
  return children.map((child, i) => renderNode(child, i))
}

// Loose alias map — open-weights models often emit plausible-but-wrong names.
// Map them to the closest real component so the output still renders.
const COMPONENT_ALIASES: Record<string, string> = {
  h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading',
  p: 'Text', paragraph: 'Text', span: 'Text',
  div: 'Stack', section: 'Stack', container: 'Stack', row: 'Flex', column: 'Stack',
  button: 'ActionCard', action: 'ActionCard', cta: 'ActionCard',
  recap: 'Card', summary: 'Card', panel: 'Card', box: 'Card', callout: 'Alert',
  group: 'Stack', wrapper: 'Stack',
  label: 'Badge', tag: 'Badge', chip: 'Badge',
}

function renderNode(node: JsonNode | string, key: number): ReactNode {
  if (typeof node === 'string') return node
  if (node == null) return null

  const { component, props = {}, children } = node
  const name = (component ?? '').trim()
  const Resolved =
    COMPONENTS[name] ??
    (COMPONENT_ALIASES[name.toLowerCase()] ? COMPONENTS[COMPONENT_ALIASES[name.toLowerCase()]] : undefined)

  if (!Resolved) {
    // Graceful fallback: preserve the agent's content even if the component
    // name is hallucinated. Users never see a cryptic "Unknown component" error.
    return (
      <div key={key} className="space-y-3">
        {renderChildren(children)}
      </div>
    )
  }
  return <Resolved key={key} {...props}>{renderChildren(children)}</Resolved>
}

// ─── Layout Components ───

function Stack({ children, gap = 4, align }: { children: ReactNode; gap?: number; align?: string }) {
  return (
    <div className={`flex flex-col min-w-0 gap-${gap} ${align ? `items-${align}` : ''}`} style={{ gap: `${gap * 4}px` }}>
      {children}
    </div>
  )
}

function Grid({ children, columns = 2, gap = 4 }: { children: ReactNode; columns?: number; gap?: number }) {
  // Honour the requested column count on real estate, collapse to one column
  // on phones (the `.ui-grid` rule in styles.css). An earlier `auto-fit`
  // version packed as MANY min-width tracks as fit — on a wide frame that made
  // 6 narrow tracks for 4 cards, cramming them left with dead space right.
  return (
    <div
      className="ui-grid grid min-w-0"
      style={{
        gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`,
        gap: `${gap * 4}px`,
      }}
    >
      {children}
    </div>
  )
}

function Flex({ children, direction = 'row', gap = 4, justify, align }: {
  children: ReactNode; direction?: string; gap?: number; justify?: string; align?: string
}) {
  return (
    <div
      className="flex flex-wrap min-w-0"
      style={{
        flexDirection: direction as any,
        gap: `${gap * 4}px`,
        justifyContent: justify,
        alignItems: align,
      }}
    >
      {children}
    </div>
  )
}

// ─── Content Components ───

function Heading({ children, level = 2 }: { children: ReactNode; level?: number }) {
  // Weight + tracking variety creates vertical rhythm — the bigger the
  // heading, the heavier and tighter the letterforms (display-style scaling).
  // Smaller headings drop to medium so they can sit close to body text
  // without competing for attention.
  const styles: Record<number, string> = {
    1: 'text-3xl font-extrabold tracking-tighter',
    2: 'text-2xl font-bold tracking-tight',
    3: 'text-xl font-semibold tracking-tight',
    4: 'text-lg font-medium',
    5: 'text-base font-medium',
    6: 'text-sm font-medium',
  }
  const cls = `${styles[level] || styles[2]} text-white break-words`
  if (level === 1) return <h1 className={cls}>{children}</h1>
  if (level === 3) return <h3 className={cls}>{children}</h3>
  if (level === 4) return <h4 className={cls}>{children}</h4>
  if (level === 5) return <h5 className={cls}>{children}</h5>
  if (level === 6) return <h6 className={cls}>{children}</h6>
  return <h2 className={cls}>{children}</h2>
}

function Text({ children, size, weight }: {
  children: ReactNode; size?: string; color?: string; weight?: string
}) {
  return (
    <p className={`${size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-lg' : 'text-base'} text-gray-300 leading-relaxed break-words ${weight === 'bold' ? 'font-bold' : ''}`}>
      {children}
    </p>
  )
}

// Badge palette — saturation audit (taste-skill checklist):
//   bg uses Tailwind 500-level @ /20 alpha → effective saturation well under
//   80% over a void background. text uses 300-level (lighter, lower-chroma)
//   so the foreground reads as accent, not signal-blast. border at /30 alpha
//   keeps the card edge legible without re-saturating the chip. Acceptable
//   as-is per the redesign-skill cap.
const BADGE_COLORS: Record<string, string> = {
  blue: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  green: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  red: 'bg-red-500/20 text-red-300 border-red-500/30',
  yellow: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  gray: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  purple: 'bg-white/10 text-gray-200 border-white/20',
}

function Badge({ children, variant = 'blue' }: { children: ReactNode; variant?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${BADGE_COLORS[variant] || BADGE_COLORS.blue}`}>
      {children}
    </span>
  )
}

function Code({ children }: { children: ReactNode; language?: string }) {
  return (
    <pre className="rounded-sm bg-void/70 border border-white/5 p-4 overflow-x-auto max-w-full" data-no-frame-scroll>
      <code className="text-sm text-bone font-mono">{children}</code>
    </pre>
  )
}

// ─── Data Components ───

function Card({ children, variant = 'outlined' }: { children: ReactNode; variant?: string }) {
  const styles: Record<string, string> = {
    outlined: 'glass-card',
    filled: 'bg-white/8 rounded-2xl border border-white/10',
    elevated: 'glass-card shadow-lg shadow-black/20',
  }
  return (
    <div className={`${styles[variant] || styles.outlined} p-5 min-w-0 break-words`}>
      {children}
    </div>
  )
}

function Table({ headers, rows }: { headers: string[]; rows: string[][]; children?: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/8">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-white/5">
            {headers.map((h, i) => (
              <th key={i} className="px-4 py-3 text-left font-semibold text-gray-200">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-white/5">
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-3 text-gray-300">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function List({ children, ordered, items }: { children?: ReactNode; ordered?: boolean; items?: string[] }) {
  const Tag = ordered ? 'ol' : 'ul'
  if (items) {
    return (
      <Tag className={`${ordered ? 'list-decimal' : 'list-disc'} pl-5 space-y-1.5 text-gray-300`}>
        {items.map((item, i) => <li key={i}>{item}</li>)}
      </Tag>
    )
  }
  return (
    <Tag className={`${ordered ? 'list-decimal' : 'list-disc'} pl-5 space-y-1.5 text-gray-300`}>
      {children}
    </Tag>
  )
}

function Progress({ value = 0, label }: { value: number; label?: string; children?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      {label && <div className="flex justify-between text-sm"><span className="text-gray-300">{label}</span><span className="text-gray-400">{value}%</span></div>}
      <div className="h-2.5 rounded-full bg-white/8 overflow-hidden">
        <div className="h-full rounded-full bg-crimson transition-all duration-500" style={{ width: `${value}%` }} />
      </div>
    </div>
  )
}

// ─── Interactive Components ───

function Tabs({ tabs }: { tabs: { label: string; content: JsonNode | string }[]; children?: ReactNode }) {
  const [active, setActive] = useState(0)
  if (!tabs) return null
  return (
    <div>
      {/* Horizontal scroll rail so 4+ tabs never overflow a phone width —
          the row scrolls instead of blowing out the frame. Scrollbar hidden;
          the fade-free overflow keeps the rest of the frame static. */}
      <div className="flex gap-1 border-b border-white/8 mb-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-no-frame-scroll>
        {tabs.map((tab, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            className={`shrink-0 px-4 py-2.5 text-sm font-medium transition-colors rounded-t-lg focus-visible:ring-2 focus-visible:ring-crimson focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none ${
              i === active
                ? 'text-white bg-white/8 border-b border-white'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div>{renderNode(tabs[active].content as any, active)}</div>
    </div>
  )
}

function Accordion({ items }: { items: { title: string; content: JsonNode | string }[]; children?: ReactNode }) {
  const [open, setOpen] = useState<number | null>(null)
  if (!items) return null
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="glass-card overflow-hidden">
          <button
            onClick={() => setOpen(open === i ? null : i)}
            className="w-full px-5 py-3.5 text-left text-sm font-medium text-gray-200 hover:text-white flex justify-between items-center focus-visible:ring-2 focus-visible:ring-crimson focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none"
          >
            {item.title}
            <span className={`transition-transform ${open === i ? 'rotate-180' : ''}`}>&#9662;</span>
          </button>
          {open === i && (
            <div className="px-5 pb-4 text-gray-300 text-sm">
              {typeof item.content === 'string' ? item.content : renderNode(item.content, i)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

const ALERT_STYLES: Record<string, { bg: string; border: string; icon: string }> = {
  info: { bg: 'bg-blue-500/10', border: 'border-blue-500/20', icon: 'i' },
  warning: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', icon: '!' },
  error: { bg: 'bg-red-500/10', border: 'border-red-500/20', icon: 'x' },
  success: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: '✓' },
}

function Alert({ variant = 'info', title, message, children }: {
  variant?: string; title?: string; message?: string; children?: ReactNode
}) {
  const style = ALERT_STYLES[variant] || ALERT_STYLES.info
  return (
    <div className={`${style.bg} border ${style.border} rounded-xl p-4`}>
      {title && <div className="text-sm font-semibold text-gray-200 mb-1">{title}</div>}
      {message && <div className="text-sm text-gray-300">{message}</div>}
      {children}
    </div>
  )
}

// ─── Action Components ───

function ActionCard({ children, prompt, icon, label, title, text, variant = 'default' }: {
  children?: ReactNode; prompt: string; icon?: string; label?: string; title?: string; text?: string; variant?: string
}) {
  const onAction = useContext(ActionContext)
  // Agent might put the label as children, label, title, or text prop — handle all
  const displayText = children || label || title || text || prompt
  // The agent frequently emits a card with only a label and NO `prompt`, which
  // fired onAction(undefined) — a button that looked live but did nothing.
  // Fall back to the visible text so every rendered card is genuinely
  // clickable, and disable it outright when there's nothing to ask.
  const flatten = (n: ReactNode): string =>
    typeof n === 'string'
      ? n
      : Array.isArray(n)
        ? n.map(flatten).join(' ')
        : typeof n === 'number'
          ? String(n)
          : ''
  const effectivePrompt =
    (typeof prompt === 'string' && prompt.trim() ? prompt : '') ||
    flatten(displayText).trim()
  const actionable = Boolean(onAction && effectivePrompt)
  const variants: Record<string, string> = {
    default: 'border-white/8 hover:border-white/25 hover:bg-white/5',
    primary: 'border-white/15 bg-white/5 hover:bg-white/8',
    subtle: 'border-white/5 hover:border-white/12 hover:bg-white/3',
  }
  return (
    <button
      type="button"
      onClick={() => {
        if (actionable) onAction?.(effectivePrompt)
      }}
      disabled={!actionable}
      aria-disabled={!actionable}
      title={actionable ? `Ask: ${effectivePrompt}` : undefined}
      className={`glass-card w-full text-left px-5 py-4 transition-all group focus-visible:ring-2 focus-visible:ring-crimson focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none ${
        actionable ? 'cursor-pointer' : 'cursor-default opacity-60'
      } ${variants[variant] || variants.default}`}
    >
      <div className="flex items-center gap-3">
        {icon && <span className="text-xl">{icon}</span>}
        <span className="text-sm text-gray-200 group-hover:text-white transition-colors">
          {displayText}
        </span>
        <svg className="ml-auto shrink-0 w-4 h-4 text-gray-600 group-hover:text-white transition-colors" viewBox="0 0 16 16" fill="none">
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </button>
  )
}

// ─── Quiz Components ───

// QuizMCQ — note: NO `correctAnswer` prop. The server resolves the correct
// answer by reading the persisted explanation config; clients can no longer
// assert their own. The mutation returns `correctAnswer` so we can still
// highlight the right option after grading.
type QuizMCQProps = {
  question: string
  options: string[]
  concept?: string
  questionIndex?: number
}

function QuizMCQ({ question, options, concept, questionIndex = 0 }: QuizMCQProps) {
  const explanationId = useContext(QuizExplanationContext)
  const recordAnswer = useMutation(api.quiz.recordAnswer)
  const [selected, setSelected] = useState<string | null>(null)
  const [submittedCorrect, setSubmittedCorrect] = useState<boolean | null>(null)
  // Server-returned correct answer — display-only. Never used to grade.
  const [revealedCorrect, setRevealedCorrect] = useState<string | null>(null)
  // Hard guard against double-submit races: e.g. user double-clicks an
  // option, or React StrictMode re-invokes onPick while the first await is
  // pending and `selected` hasn't flushed yet. The ref is synchronously
  // updated, so the second invocation short-circuits before any state read.
  const submittedRef = useRef(false)

  const onPick = async (option: string) => {
    if (submittedRef.current) return
    submittedRef.current = true
    setSelected(option)
    if (!explanationId) {
      // Defensive — quiz outside an explanation context. We can't grade
      // without the server (no config to read from); just mark as picked.
      setSubmittedCorrect(null)
      return
    }
    try {
      const { correct, correctAnswer } = await recordAnswer({
        explanationId,
        questionIndex,
        selectedAnswer: option,
        concept,
      })
      setSubmittedCorrect(correct)
      setRevealedCorrect(correctAnswer)
    } catch (err) {
      console.warn('[quiz] record failed:', err)
      // Don't unlock the UI on failure — releasing submittedRef would let
      // the user retry, but we can't grade without the server, so the
      // honest UX is to leave the choice locked and show no result.
      setSubmittedCorrect(null)
    }
  }

  return (
    <div className="glass-card p-5 space-y-4">
      <p className="text-bone text-base font-mono leading-relaxed">{question}</p>
      <div className="space-y-2">
        {options.map((opt) => {
          const isPicked = selected === opt
          const isCorrect =
            revealedCorrect != null &&
            opt.trim().toLowerCase() === revealedCorrect.trim().toLowerCase()
          let cls = 'border-white/10 hover:border-white/30 hover:bg-white/[0.04]'
          if (selected) {
            if (isPicked && submittedCorrect) cls = 'border-emerald-500/60 bg-emerald-500/10'
            else if (isPicked && submittedCorrect === false) cls = 'border-crimson/60 bg-crimson/10'
            else if (!isPicked && isCorrect) cls = 'border-emerald-500/30 bg-emerald-500/5'
            else cls = 'border-white/5 opacity-50'
          }
          return (
            <button
              key={opt}
              type="button"
              disabled={selected !== null}
              onClick={() => void onPick(opt)}
              className={`w-full text-left px-4 py-3 rounded-sm border transition text-sm text-bone font-mono focus-visible:ring-2 focus-visible:ring-crimson focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none ${cls}`}
            >
              <span className="text-ash mr-2">·</span>
              {opt}
              {selected && isPicked && submittedCorrect && (
                <span className="ml-2 text-emerald-400 text-xs">correct</span>
              )}
              {selected && isPicked && submittedCorrect === false && (
                <span className="ml-2 text-crimson text-xs">try again next time</span>
              )}
              {selected && !isPicked && isCorrect && (
                <span className="ml-2 text-emerald-400/70 text-[10px] uppercase tracking-wide">
                  was correct
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// QuizFill — same pattern as QuizMCQ. `correctAnswer` is no longer a prop;
// the server returns it after grading so we can show the canonical answer.
type QuizFillProps = {
  question: string
  concept?: string
  questionIndex?: number
  hint?: string
}

function QuizFill({ question, concept, questionIndex = 0, hint }: QuizFillProps) {
  const explanationId = useContext(QuizExplanationContext)
  const recordAnswer = useMutation(api.quiz.recordAnswer)
  const [value, setValue] = useState('')
  const [result, setResult] = useState<boolean | null>(null)
  const [revealedCorrect, setRevealedCorrect] = useState<string | null>(null)
  // `submitted` mirrors the ref so the DOM re-renders disabled state; the
  // ref is the sync race guard (state updates batch / lag a microtask, the
  // ref flips immediately so a second invocation short-circuits).
  const [submitted, setSubmitted] = useState(false)
  const submittedRef = useRef(false)

  const submit = async () => {
    if (submittedRef.current || !value.trim()) return
    submittedRef.current = true
    setSubmitted(true)
    if (!explanationId) {
      // Without an explanation context we can't grade; lock the input but
      // surface no result.
      setResult(null)
      return
    }
    try {
      const { correct, correctAnswer } = await recordAnswer({
        explanationId,
        questionIndex,
        selectedAnswer: value,
        concept,
      })
      setResult(correct)
      setRevealedCorrect(correctAnswer)
    } catch (err) {
      console.warn('[quiz] record failed:', err)
      setResult(null)
    }
  }

  return (
    <div className="glass-card p-5 space-y-4">
      <p className="text-bone text-base font-mono leading-relaxed">{question}</p>
      {hint && <p className="text-ash text-xs font-mono">hint · {hint}</p>}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          disabled={submitted}
          className="input-bmth flex-1 focus-visible:ring-2 focus-visible:ring-crimson focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none"
          placeholder="your answer"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitted || !value.trim()}
          className="btn-crimson focus-visible:ring-2 focus-visible:ring-crimson focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none"
        >
          check
        </button>
      </div>
      {result === true && revealedCorrect && (
        <p className="text-emerald-400 text-xs font-mono">
          correct — {revealedCorrect}
        </p>
      )}
      {result === false && revealedCorrect && (
        <p className="text-crimson text-xs font-mono">
          not quite — answer was {revealedCorrect}
        </p>
      )}
    </div>
  )
}

// ─── Component Registry ───

const COMPONENTS: Record<string, React.FC<any>> = {
  Stack,
  Grid,
  Flex,
  Heading,
  Text,
  Badge,
  Code,
  Card,
  Table,
  List,
  Progress,
  Tabs,
  Accordion,
  Alert,
  ActionCard,
  QuizMCQ,
  QuizFill,
}

// ─── Public API ───

export function UIRenderer({
  config,
  onAction,
  explanationId,
}: {
  config: JsonNode
  onAction?: ActionHandler
  explanationId?: Id<'explanations'>
}) {
  return (
    <QuizExplanationContext.Provider value={explanationId ?? null}>
      <ActionContext.Provider value={onAction ?? null}>
        <div className="space-y-4">{renderNode(config, 0)}</div>
      </ActionContext.Provider>
    </QuizExplanationContext.Provider>
  )
}
