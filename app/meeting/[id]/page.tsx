"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import PlatformNavbar from "@/app/components/PlatformNavbar";
import RecruitmentMeetingRoom from "@/app/components/company/RecruitmentMeetingRoom";
import {
  getToken,
  getRecruitmentMeeting,
  markMeetingStarted,
  completeMeeting,
  reviewMeeting,
  type RecruitmentMeeting,
} from "@/app/lib/api";

const SOFT_SKILLS = [
  "communication",
  "empathy",
  "confidence",
  "leadership",
  "adaptability",
  "stress_management",
] as const;

type SoftSkillKey = (typeof SOFT_SKILLS)[number];

const SKILL_LABELS: Record<SoftSkillKey, string> = {
  communication: "Communication",
  empathy: "Empathie",
  confidence: "Confiance",
  leadership: "Leadership",
  adaptability: "Adaptabilité",
  stress_management: "Gestion du stress",
};

export default function MeetingPage() {
  const params = useParams();
  const router = useRouter();
  const id = typeof params.id === "string" ? params.id : "";

  const [meeting, setMeeting] = useState<RecruitmentMeeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const finalScoresRef = useRef<Record<string, number> | undefined>(undefined);
  const [showReview, setShowReview] = useState(false);

  // ───────── Initial fetch ─────────
  useEffect(() => {
    if (!getToken()) {
      router.replace(`/signin?next=${encodeURIComponent(`/meeting/${id}`)}`);
      return;
    }
    if (!id) return;
    getRecruitmentMeeting(id)
      .then(setMeeting)
      .catch((err: any) => setError(err?.message ?? "Meeting introuvable."))
      .finally(() => setLoading(false));
  }, [id, router]);

  // ───────── Candidate auto-entry polling ─────────
  // When the candidate is on the lobby and the recruiter flips the meeting
  // to STARTED, automatically enter the room.
  useEffect(() => {
    if (!meeting) return;
    if (active) return;
    if (meeting.role !== "CANDIDATE") return;
    if (meeting.status !== "SCHEDULED") return; // only poll while waiting

    let cancelled = false;
    const poll = async () => {
      try {
        const fresh = await getRecruitmentMeeting(id);
        if (cancelled) return;
        setMeeting(fresh);
        if (fresh.status === "STARTED") {
          setActive(true);
        }
      } catch {
        /* keep polling */
      }
    };
    const t = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [meeting, active, id]);

  // ───────── Handlers ─────────
  const handleEnter = async () => {
    if (!meeting) return;
    try {
      await markMeetingStarted(meeting.id);
      setMeeting((m) => (m ? { ...m, status: "STARTED" } : m));
      setActive(true);
    } catch {
      setActive(true);
    }
  };

  const handleMeetingEnd = async (results: any[]) => {
    if (!meeting) return;
    const summary = computeAverageScores(results);
    finalScoresRef.current = summary;
    try {
      const res = await completeMeeting(meeting.id, summary);
      setMeeting((m) =>
        m ? { ...m, status: "COMPLETED", softSkillsScore: res.softSkillsScore ?? summary ?? null } : m,
      );
    } catch (err) {
      console.error("Failed to persist final soft-skills:", err);
      setMeeting((m) => (m ? { ...m, status: "COMPLETED", softSkillsScore: summary ?? null } : m));
    }
    setActive(false);
    // Recruiter: open the review panel automatically
    if (meeting.role === "COMPANY") setShowReview(true);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col">
        <PlatformNavbar />
        <div className="flex-1 flex items-center justify-center gap-3">
          <div className="w-10 h-10 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
          <p className="text-[10px] font-black tracking-[0.3em] text-white/40 uppercase">Chargement du meeting…</p>
        </div>
      </div>
    );
  }

  if (error || !meeting) {
    return (
      <div className="min-h-screen flex flex-col">
        <PlatformNavbar />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-3xl border border-red-500/20 bg-red-500/5 backdrop-blur-xl p-8 text-center space-y-4">
            <p className="text-[10px] font-black tracking-[0.3em] text-red-400 uppercase">Accès refusé</p>
            <h1 className="text-xl font-black italic uppercase text-white">Meeting introuvable</h1>
            <p className="text-sm text-white/60 font-mono">{error || "Ce lien n'est pas valide ou tu n'es pas invité à ce meeting."}</p>
            <Link href="/hackathon" className="inline-block px-6 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black text-[11px] font-black uppercase tracking-[0.2em] transition-all">
              Retour
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const scheduledDate = new Date(meeting.scheduledFor);
  const youAre = meeting.role === "COMPANY" ? "Recruteur" : "Candidat";
  const otherParty =
    meeting.role === "COMPANY"
      ? `${meeting.candidate?.firstName ?? meeting.candidateName}`
      : meeting.companyName;
  const isRecruiter = meeting.role === "COMPANY";
  const isCompleted = meeting.status === "COMPLETED";

  return (
    <div className="min-h-screen flex flex-col">
      <PlatformNavbar />
      <main className="flex-1 relative z-10">
        {!active ? (
          <div className="max-w-3xl mx-auto px-6 py-10 md:py-14 space-y-6">
            {/* ─── Lobby / pre-meeting card ─── */}
            <div className="relative rounded-3xl border border-cyan-500/20 bg-white/[0.03] backdrop-blur-xl shadow-2xl overflow-hidden">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-cyan-500 to-transparent" aria-hidden />
              <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-cyan-500/10 blur-[100px] pointer-events-none" aria-hidden />

              <div className="relative p-8 md:p-10 space-y-7">
                <div className="flex items-start gap-4">
                  <div className="shrink-0 w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                    <svg className="w-6 h-6 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-black tracking-[0.3em] text-cyan-400 uppercase">Recruitment Meeting</p>
                    <h1 className="mt-1 text-3xl md:text-4xl font-black italic uppercase tracking-tight text-white leading-tight">
                      {meeting.companyName} <span className="text-cyan-400">×</span> {meeting.candidate?.firstName ?? meeting.candidateName.split(" ")[0]}
                    </h1>
                    <p className="mt-1 text-sm text-white/40">Soft-skills analysis intégrée · webcam + audio</p>
                  </div>
                </div>

                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <InfoBlock label="Tu es" value={youAre} accent="cyan" />
                  <InfoBlock label={isRecruiter ? "Candidat" : "Entreprise"} value={otherParty} accent="violet" />
                  <InfoBlock
                    label="Date"
                    value={scheduledDate.toLocaleDateString("fr-FR", {
                      weekday: "long", day: "2-digit", month: "long", year: "numeric",
                    })}
                  />
                  <InfoBlock
                    label="Heure"
                    value={`${scheduledDate.toLocaleTimeString("fr-FR", {
                      hour: "2-digit", minute: "2-digit",
                    })} · ${meeting.durationMinutes} min`}
                  />
                  <InfoBlock label="Statut" value={meeting.status} accent={meeting.status === "COMPLETED" ? "emerald" : meeting.status === "CANCELLED" ? "red" : meeting.status === "STARTED" ? "amber" : "cyan"} />
                  {meeting.candidate?.mainSpecialty && (
                    <InfoBlock label="Spécialité" value={meeting.candidate.mainSpecialty} accent="cyan" />
                  )}
                </dl>

                {meeting.notes && (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                    <p className="text-[10px] font-black tracking-[0.3em] text-white/40 uppercase mb-2">Notes du recruteur</p>
                    <p className="text-sm text-white/70 leading-relaxed whitespace-pre-wrap">{meeting.notes}</p>
                  </div>
                )}

                {meeting.status === "CANCELLED" ? (
                  <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-xs font-black uppercase tracking-widest text-red-400 text-center">
                    Ce meeting a été annulé.
                  </div>
                ) : isCompleted ? (
                  <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-3 text-xs font-black uppercase tracking-widest text-emerald-400 text-center">
                    Meeting terminé — soft-skills enregistrés.
                  </div>
                ) : !isRecruiter && meeting.status === "SCHEDULED" ? (
                  // Candidate waiting — auto-enter when recruiter starts
                  <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-5 text-center space-y-3">
                    <div className="flex items-center justify-center gap-2 text-cyan-300">
                      <span className="relative flex h-2.5 w-2.5">
                        <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75 animate-ping" />
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-400" />
                      </span>
                      <p className="text-[10px] font-black tracking-[0.3em] uppercase">En attente du recruteur</p>
                    </div>
                    <p className="text-sm text-white/70">
                      Tu rejoindras la salle <span className="text-cyan-300 font-black">automatiquement</span> dès que <span className="font-black text-white">{meeting.companyName}</span> lance le meeting.
                    </p>
                    <button
                      onClick={handleEnter}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-black uppercase tracking-widest text-white/60 hover:text-white transition-all"
                    >
                      Entrer maintenant
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleEnter}
                    className="w-full inline-flex items-center justify-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-black p-4 rounded-2xl font-black uppercase tracking-[0.2em] text-sm transition-all shadow-xl shadow-cyan-500/30"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
                    {isRecruiter && meeting.status === "SCHEDULED" ? "Lancer le meeting" : "Entrer dans la salle"}
                  </button>
                )}

                <p className="text-[10px] text-white/30 text-center font-mono">
                  Assure-toi que ta caméra et ton micro fonctionnent avant d'entrer.
                </p>
              </div>
            </div>

            {/* ─── Recruiter review panel (appears when meeting is COMPLETED) ─── */}
            {isRecruiter && isCompleted && (
              <RecruiterReviewPanel
                meeting={meeting}
                onReviewSaved={(updated) => setMeeting((m) => (m ? { ...m, ...updated } : m))}
                openByDefault={showReview}
              />
            )}
          </div>
        ) : (
          // ─── Active meeting room ───
          <div className="px-6 py-6 max-w-7xl mx-auto">
            <RecruitmentMeetingRoom
              candidateName={(meeting.candidate?.firstName ?? "") + " " + (meeting.candidate?.lastName ?? "") || meeting.candidateName}
              onMeetingEnd={handleMeetingEnd}
            />
          </div>
        )}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Recruiter review panel — score sliders + decision + send result
// ─────────────────────────────────────────────────────────────────
function RecruiterReviewPanel({
  meeting,
  onReviewSaved,
  openByDefault,
}: {
  meeting: RecruitmentMeeting;
  onReviewSaved: (updated: Partial<RecruitmentMeeting>) => void;
  openByDefault?: boolean;
}) {
  const ai = (meeting.softSkillsScore ?? {}) as Record<string, number>;
  const existingRecruiter = (meeting.recruiterScore ?? {}) as Record<string, number>;
  const [open, setOpen] = useState(openByDefault ?? false);
  const [scores, setScores] = useState<Record<SoftSkillKey, number>>(() => {
    const base: Record<SoftSkillKey, number> = {} as any;
    for (const k of SOFT_SKILLS) {
      base[k] = Number(existingRecruiter[k] ?? ai[k] ?? 5);
    }
    return base;
  });
  const [decision, setDecision] = useState<"HIRE" | "REJECT" | null>(
    meeting.decision === "HIRE" || meeting.decision === "REJECT" ? meeting.decision : null,
  );
  const [note, setNote] = useState(meeting.decisionNote ?? "");
  const [sendEmail, setSendEmail] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const aiAvg =
    SOFT_SKILLS.reduce((sum, k) => sum + Number(ai[k] ?? 0), 0) / SOFT_SKILLS.length;
  const recruiterAvg =
    SOFT_SKILLS.reduce((sum, k) => sum + scores[k], 0) / SOFT_SKILLS.length;
  const avgDelta = recruiterAvg - aiAvg;

  const alreadyReviewed = meeting.decision === "HIRE" || meeting.decision === "REJECT";

  const submit = async () => {
    if (!decision) {
      setErrorMsg("Choisis HIRE ou REJECT avant d'envoyer.");
      return;
    }
    setSaving(true);
    setErrorMsg(null);
    setSavedMsg(null);
    try {
      const res = await reviewMeeting(meeting.id, {
        recruiterScore: scores,
        decision,
        decisionNote: note.trim() || undefined,
        sendEmail,
      });
      onReviewSaved({
        recruiterScore: res.recruiterScore ?? null,
        decision: res.decision,
        decisionNote: note.trim() || null,
        reviewedAt: res.reviewedAt ?? new Date().toISOString(),
        resultEmailedAt: res.resultEmailedAt ?? null,
      });
      setSavedMsg(
        sendEmail
          ? `Review envoyée — email avec le verdict envoyé à ${meeting.candidateEmail}.`
          : `Review enregistrée (email non envoyé).`,
      );
    } catch (err: any) {
      setErrorMsg(err?.message ?? "Erreur d'envoi de la review.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative rounded-3xl border border-violet-500/20 bg-white/[0.03] backdrop-blur-xl shadow-2xl overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-violet-500 to-transparent" aria-hidden />
      <div className="absolute -top-24 -left-24 w-72 h-72 rounded-full bg-violet-500/10 blur-[100px] pointer-events-none" aria-hidden />

      <div className="relative p-7 space-y-5">
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center justify-between gap-4 text-left"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="shrink-0 w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/30 flex items-center justify-center">
              <svg className="w-5 h-5 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black tracking-[0.3em] text-violet-400 uppercase">Review du recruteur</p>
              <p className="text-base font-black italic uppercase text-white truncate">
                {alreadyReviewed ? `Review : ${meeting.decision}` : "À compléter"}
              </p>
            </div>
          </div>
          <span className="text-white/40 text-xs font-mono">{open ? "▾" : "▸"}</span>
        </button>

        {open && (
          <div className="space-y-6 pt-4 border-t border-white/5 animate-in fade-in slide-in-from-top-2 duration-200">
            {/* Score sliders */}
            <div className="space-y-3">
              <p className="text-[10px] font-black tracking-[0.3em] text-white/40 uppercase">
                Ta note par soft-skill (0 → 10)
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {SOFT_SKILLS.map((k) => {
                  const aiVal = Number(ai[k] ?? 0);
                  const myVal = scores[k];
                  const delta = myVal - aiVal;
                  return (
                    <div key={k} className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-black uppercase tracking-widest text-white/80">
                          {SKILL_LABELS[k]}
                        </p>
                        <span className={`text-[10px] font-mono font-black ${
                          delta > 0 ? "text-emerald-400" : delta < 0 ? "text-red-400" : "text-white/40"
                        }`}>
                          {delta >= 0 ? "+" : ""}{delta.toFixed(1)}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={10}
                        step={0.5}
                        value={myVal}
                        onChange={(e) =>
                          setScores((s) => ({ ...s, [k]: Number(e.target.value) }))
                        }
                        className="w-full accent-violet-500"
                      />
                      <div className="flex items-center justify-between text-[10px] font-mono">
                        <span className="text-cyan-400">AI: {aiVal.toFixed(1)}</span>
                        <span className="text-violet-400 font-black">Recruteur: {myVal.toFixed(1)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="rounded-xl border border-white/10 bg-black/30 p-4 grid grid-cols-3 gap-3 text-center">
                <div>
                  <p className="text-[9px] font-black text-white/30 uppercase tracking-widest">AI avg</p>
                  <p className="text-2xl font-black italic text-cyan-400 font-mono">{aiAvg.toFixed(1)}</p>
                </div>
                <div>
                  <p className="text-[9px] font-black text-white/30 uppercase tracking-widest">Recruteur avg</p>
                  <p className="text-2xl font-black italic text-violet-400 font-mono">{recruiterAvg.toFixed(1)}</p>
                </div>
                <div>
                  <p className="text-[9px] font-black text-white/30 uppercase tracking-widest">Écart</p>
                  <p className={`text-2xl font-black italic font-mono ${
                    avgDelta > 0.5 ? "text-emerald-400" : avgDelta < -0.5 ? "text-red-400" : "text-white"
                  }`}>
                    {avgDelta >= 0 ? "+" : ""}{avgDelta.toFixed(1)}
                  </p>
                </div>
              </div>
            </div>

            {/* Decision */}
            <div className="space-y-2">
              <p className="text-[10px] font-black tracking-[0.3em] text-white/40 uppercase">Décision finale</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setDecision("HIRE")}
                  className={`p-4 rounded-2xl border text-left transition-all ${
                    decision === "HIRE"
                      ? "bg-emerald-500/15 border-emerald-500/50 ring-2 ring-emerald-500/40"
                      : "bg-white/5 border-white/10 hover:border-emerald-500/30"
                  }`}
                >
                  <p className={`text-sm font-black uppercase tracking-widest ${decision === "HIRE" ? "text-emerald-300" : "text-white/60"}`}>
                    ✓ Recruter
                  </p>
                  <p className="text-[10px] mt-1 text-white/40">Le candidat passe à l'étape suivante</p>
                </button>
                <button
                  type="button"
                  onClick={() => setDecision("REJECT")}
                  className={`p-4 rounded-2xl border text-left transition-all ${
                    decision === "REJECT"
                      ? "bg-red-500/15 border-red-500/50 ring-2 ring-red-500/40"
                      : "bg-white/5 border-white/10 hover:border-red-500/30"
                  }`}
                >
                  <p className={`text-sm font-black uppercase tracking-widest ${decision === "REJECT" ? "text-red-300" : "text-white/60"}`}>
                    ✕ Ne pas recruter
                  </p>
                  <p className="text-[10px] mt-1 text-white/40">Le candidat est notifié poliment</p>
                </button>
              </div>
            </div>

            {/* Note */}
            <div className="space-y-2">
              <label className="text-[10px] font-black tracking-[0.3em] text-white/40 uppercase">
                Message au candidat (optionnel)
              </label>
              <textarea
                rows={3}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Feedback constructif, prochaine étape, raison…"
                className="w-full bg-white/5 border border-white/10 focus:border-violet-500/50 p-3 rounded-xl text-white font-mono text-sm outline-none transition-all resize-none placeholder:text-white/20"
              />
              <p className="text-[9px] font-mono text-white/30 text-right">{note.length}/500</p>
            </div>

            {/* Send email toggle */}
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={sendEmail}
                onChange={(e) => setSendEmail(e.target.checked)}
                className="sr-only peer"
              />
              <div className="relative w-11 h-6 rounded-full bg-white/10 peer-checked:bg-violet-500/40 transition-colors">
                <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${sendEmail ? "translate-x-5" : ""}`} />
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-widest text-white">Envoyer le résultat par email</p>
                <p className="text-[10px] text-white/40">
                  À {meeting.candidateEmail} — avec la comparaison AI vs recruteur et le verdict.
                </p>
              </div>
            </label>

            {savedMsg && (
              <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-3 text-xs font-black uppercase tracking-widest text-emerald-300">
                ✓ {savedMsg}
              </div>
            )}
            {errorMsg && (
              <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-xs font-black uppercase tracking-widest text-red-400">
                ✕ {errorMsg}
              </div>
            )}

            <button
              onClick={submit}
              disabled={saving || !decision}
              className="w-full inline-flex items-center justify-center gap-2 p-4 rounded-2xl bg-violet-500 hover:bg-violet-400 text-black font-black uppercase tracking-[0.2em] text-sm transition-all shadow-xl shadow-violet-500/30 disabled:bg-violet-500/20 disabled:text-violet-300/40 disabled:shadow-none disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-black/40 border-t-transparent rounded-full animate-spin" />
                  Envoi…
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
                  {sendEmail ? "Envoyer la review au candidat" : "Enregistrer la review"}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function InfoBlock({
  label,
  value,
  accent = "default",
}: {
  label: string;
  value: string;
  accent?: "default" | "cyan" | "violet" | "emerald" | "red" | "amber";
}) {
  const accentClass =
    accent === "cyan" ? "text-cyan-400" :
    accent === "violet" ? "text-violet-400" :
    accent === "emerald" ? "text-emerald-400" :
    accent === "red" ? "text-red-400" :
    accent === "amber" ? "text-amber-400" :
    "text-white";
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <p className="text-[9px] font-black tracking-[0.3em] text-white/30 uppercase">{label}</p>
      <p className={`mt-1 text-sm font-black italic uppercase ${accentClass}`}>{value}</p>
    </div>
  );
}

function computeAverageScores(results: any[]): Record<string, number> | undefined {
  if (!results?.length) return undefined;
  const keys = Object.keys(results[0]?.soft_skills ?? {});
  if (!keys.length) return undefined;
  const sums: Record<string, number> = {};
  let n = 0;
  for (const r of results) {
    if (!r?.soft_skills) continue;
    n++;
    for (const k of keys) sums[k] = (sums[k] ?? 0) + (r.soft_skills[k] ?? 0);
  }
  if (!n) return undefined;
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = Math.round((sums[k] / n) * 10) / 10;
  return out;
}
