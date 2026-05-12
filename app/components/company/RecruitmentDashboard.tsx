"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import {
  scheduleRecruitmentMeeting,
  listMyCompanyMeetings,
  addFavorite,
  removeFavorite,
  getFavoriteIds,
  getMyFavorites,
  type RecruitmentMeeting,
  type FavoriteEntry,
} from "@/app/lib/api";

interface Developer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  mainSpecialty: string;
  skillTags: string[];
  totalChallenges: number;
  totalWins: number;
  winRate: number;
  avgScore: number;
  avatarUrl?: string;
}

const SPECIALTIES = ["FRONTEND", "BACKEND", "FULLSTACK", "MOBILE", "DATA", "DEVOPS", "DESIGN", "CYBERSECURITY", "BI"];

const SPECIALTY_GRADIENT: Record<string, string> = {
  FRONTEND: "from-cyan-500/30 to-blue-500/20",
  BACKEND: "from-violet-500/30 to-indigo-500/20",
  FULLSTACK: "from-emerald-500/30 to-teal-500/20",
  MOBILE: "from-pink-500/30 to-rose-500/20",
  DATA: "from-amber-500/30 to-orange-500/20",
  DEVOPS: "from-sky-500/30 to-cyan-500/20",
  DESIGN: "from-fuchsia-500/30 to-purple-500/20",
  CYBERSECURITY: "from-red-500/30 to-rose-500/20",
  BI: "from-yellow-500/30 to-amber-500/20",
};

type RecruitmentView = "TALENTS" | "MEETINGS" | "FAVORITES";

export default function RecruitmentDashboard() {
  const [view, setView] = useState<RecruitmentView>("TALENTS");
  const [searchTerm, setSearchTerm] = useState("");
  const [specialtyFilter, setSpecialtyFilter] = useState<string>("");
  const [sortBy, setSortBy] = useState<"avgScore" | "totalWins" | "winRate">("avgScore");
  const [selectedDeveloper, setSelectedDeveloper] = useState<Developer | null>(null);
  const [developers, setDevelopers] = useState<Developer[]>([]);
  const [loading, setLoading] = useState(true);

  // Favorites state
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [togglingFavorites, setTogglingFavorites] = useState<Set<string>>(new Set());
  const [favoritesList, setFavoritesList] = useState<FavoriteEntry[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);

  // Meetings tab data
  const [meetings, setMeetings] = useState<RecruitmentMeeting[]>([]);
  const [meetingsLoading, setMeetingsLoading] = useState(false);
  const [meetingsError, setMeetingsError] = useState<string | null>(null);

  // Schedule meeting modal
  const [scheduleFor, setScheduleFor] = useState<Developer | null>(null);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleDuration, setScheduleDuration] = useState(30);
  const [scheduleNotes, setScheduleNotes] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleResult, setScheduleResult] = useState<{
    id: string;
    meetingLink: string;
    candidate: { email: string; firstName: string; lastName: string };
    scheduledFor: string;
  } | null>(null);

  // ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const fetchDevelopers = async () => {
      try {
        setLoading(true);
        const params = new URLSearchParams();
        if (specialtyFilter) params.append("specialty", specialtyFilter);
        const response = await fetch(`/api/analytics/developers?${params}`);
        if (!response.ok) throw new Error("Erreur lors du chargement");
        const data = await response.json();
        setDevelopers(data.developers || []);
      } catch (err) {
        console.error("Erreur:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchDevelopers();
  }, [specialtyFilter]);

  const loadMeetings = async () => {
    setMeetingsLoading(true);
    setMeetingsError(null);
    try {
      const data = await listMyCompanyMeetings();
      setMeetings(data);
    } catch (err: any) {
      setMeetingsError(err?.message ?? "Erreur de chargement");
    } finally {
      setMeetingsLoading(false);
    }
  };

  useEffect(() => {
    if (view === "MEETINGS") loadMeetings();
    if (view === "FAVORITES") {
      setFavoritesLoading(true);
      getMyFavorites()
        .then((entries) => setFavoritesList(entries))
        .catch(() => setFavoritesList([]))
        .finally(() => setFavoritesLoading(false));
    }
  }, [view]);

  // Load the lightweight ID set on mount so cards can show their heart state immediately
  useEffect(() => {
    getFavoriteIds()
      .then((ids) => setFavoriteIds(new Set(ids)))
      .catch(() => { /* user might not be COMPANY role yet — ignore */ });
  }, []);

  const mockDevelopers: Developer[] = useMemo(() => [
    { id: "1", firstName: "Ahmed", lastName: "Mohammed", email: "ahmed@example.com", mainSpecialty: "FULLSTACK", skillTags: ["React", "Node.js", "PostgreSQL", "Docker"], totalChallenges: 45, totalWins: 32, winRate: 71, avgScore: 8.7, avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Ahmed" },
    { id: "2", firstName: "Fatima", lastName: "Al-Zahra", email: "fatima@example.com", mainSpecialty: "FRONTEND", skillTags: ["Vue.js", "Tailwind CSS", "TypeScript", "Figma"], totalChallenges: 38, totalWins: 28, winRate: 74, avgScore: 8.4, avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Fatima" },
    { id: "3", firstName: "Mohammed", lastName: "Hassan", email: "mohammed@example.com", mainSpecialty: "BACKEND", skillTags: ["Python", "FastAPI", "MongoDB", "AWS"], totalChallenges: 52, totalWins: 38, winRate: 73, avgScore: 8.9, avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Mohammed" },
    { id: "4", firstName: "Sara", lastName: "Ibrahim", email: "sara@example.com", mainSpecialty: "DATA", skillTags: ["Python", "TensorFlow", "SQL", "Tableau"], totalChallenges: 33, totalWins: 22, winRate: 67, avgScore: 8.1, avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Sara" },
    { id: "5", firstName: "Karim", lastName: "Khaled", email: "karim@example.com", mainSpecialty: "DEVOPS", skillTags: ["Kubernetes", "CI/CD", "Linux", "Terraform"], totalChallenges: 28, totalWins: 21, winRate: 75, avgScore: 8.6, avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Karim" },
  ], []);

  const isUsingMock = developers.length === 0;
  const displayDevelopers = isUsingMock ? mockDevelopers : developers;
  const isValidObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

  const filteredDevelopers = useMemo(() => {
    return displayDevelopers
      .filter((d) => {
        const matchSearch = `${d.firstName} ${d.lastName}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
          d.email.toLowerCase().includes(searchTerm.toLowerCase());
        const matchSpecialty = !specialtyFilter || d.mainSpecialty === specialtyFilter;
        return matchSearch && matchSpecialty;
      })
      .sort((a, b) => {
        if (sortBy === "avgScore") return b.avgScore - a.avgScore;
        if (sortBy === "totalWins") return b.totalWins - a.totalWins;
        return b.winRate - a.winRate;
      });
  }, [displayDevelopers, searchTerm, specialtyFilter, sortBy]);

  const stats = useMemo(() => ({
    totalDevelopers: displayDevelopers.length,
    avgScore: displayDevelopers.length
      ? (displayDevelopers.reduce((sum, d) => sum + d.avgScore, 0) / displayDevelopers.length).toFixed(1)
      : "—",
    topSpecialty: displayDevelopers[0]?.mainSpecialty ?? "—",
    topWinRate: displayDevelopers.length ? Math.max(...displayDevelopers.map((d) => d.winRate)) : 0,
  }), [displayDevelopers]);

  // ─── Modal handlers ───

  const openScheduleModal = (dev: Developer) => {
    if (!isValidObjectId(dev.id)) {
      alert(
        "Ce profil est une donnée de démo (id non valide). Connecte de vrais utilisateurs depuis l'API analytics pour pouvoir planifier un meeting.",
      );
      return;
    }
    setScheduleFor(dev);
    setSelectedDeveloper(null);
    // Default: tomorrow at 10:00 local
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(10, 0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    setScheduleDate(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`);
    setScheduleDuration(30);
    setScheduleNotes("");
    setScheduleError(null);
    setScheduleResult(null);
  };

  const closeScheduleModal = () => {
    if (scheduling) return;
    setScheduleFor(null);
    setScheduleError(null);
    setScheduleResult(null);
  };

  const handleSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scheduleFor) return;
    setScheduling(true);
    setScheduleError(null);
    try {
      const iso = new Date(scheduleDate).toISOString();
      const res = await scheduleRecruitmentMeeting({
        candidateUserId: scheduleFor.id,
        scheduledFor: iso,
        durationMinutes: scheduleDuration,
        notes: scheduleNotes.trim() || undefined,
      });
      setScheduleResult({
        id: res.id,
        meetingLink: res.meetingLink,
        candidate: res.candidate,
        scheduledFor: res.scheduledFor,
      });
    } catch (err: any) {
      setScheduleError(err?.message ?? "Échec de la planification");
    } finally {
      setScheduling(false);
    }
  };

  const handleToggleFavorite = async (userId: string) => {
    if (!isValidObjectId(userId)) return;
    const wasFavorited = favoriteIds.has(userId);

    // Optimistic UI update
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(userId); else next.add(userId);
      return next;
    });
    setTogglingFavorites((prev) => new Set([...prev, userId]));

    try {
      if (wasFavorited) {
        await removeFavorite(userId);
        setFavoritesList((prev) => prev.filter((e) => e.user.id !== userId));
      } else {
        await addFavorite(userId);
      }
    } catch {
      // Roll back on error
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(userId); else next.delete(userId);
        return next;
      });
    } finally {
      setTogglingFavorites((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  };

  // ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="shrink-0 w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
            <svg className="w-6 h-6 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-black tracking-[0.3em] text-cyan-400 uppercase">Recrutement</p>
            <h2 className="mt-1 text-2xl md:text-3xl font-black italic uppercase tracking-tight text-white leading-tight">
              Talent Pool
            </h2>
            <p className="mt-1 text-sm text-white/40">Découvre les top performers et planifie des entretiens.</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 bg-white/5 border border-white/10 rounded-xl p-1">
          <button
            onClick={() => setView("TALENTS")}
            className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
              view === "TALENTS" ? "bg-cyan-500 text-black shadow-lg shadow-cyan-500/20" : "text-white/50 hover:text-white"
            }`}
          >
            Talents
          </button>
          <button
            onClick={() => setView("MEETINGS")}
            className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
              view === "MEETINGS" ? "bg-cyan-500 text-black shadow-lg shadow-cyan-500/20" : "text-white/50 hover:text-white"
            }`}
          >
            Mes Meetings
          </button>
          <button
            onClick={() => setView("FAVORITES")}
            className={`relative px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
              view === "FAVORITES" ? "bg-rose-500 text-white shadow-lg shadow-rose-500/20" : "text-white/50 hover:text-white"
            }`}
          >
            Favoris
            {favoriteIds.size > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[8px] font-black flex items-center justify-center border border-black/30">
                {favoriteIds.size}
              </span>
            )}
          </button>
        </div>
      </div>

      {view === "TALENTS" && (
        <>
          {isUsingMock && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 backdrop-blur-xl px-5 py-4 flex items-start gap-3">
              <svg className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-black tracking-[0.3em] text-amber-400 uppercase">Mode démo</p>
                <p className="text-sm text-white/70 mt-1 leading-relaxed">
                  L'API <span className="font-mono text-amber-300">/api/analytics/developers</span> n'a renvoyé aucun talent — les profils ci-dessous sont des exemples.
                  La planification de meeting est désactivée tant qu'il n'y a pas de vrais utilisateurs.
                </p>
              </div>
            </div>
          )}

          {/* KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Metric label="Total Talents" value={stats.totalDevelopers} accent="cyan" />
            <Metric label="Score moyen" value={`${stats.avgScore} / 10`} accent="emerald" />
            <Metric label="Top spécialité" value={stats.topSpecialty} accent="violet" />
            <Metric label="Best win rate" value={`${stats.topWinRate}%`} accent="amber" />
          </div>

          {/* Filters */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="md:col-span-2 relative">
              <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
              <input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Chercher par nom ou email..."
                className="w-full bg-white/5 border border-white/10 focus:border-cyan-500/50 pl-11 pr-4 py-3 rounded-xl text-sm font-mono text-white outline-none placeholder:text-white/20 transition-all"
              />
            </div>
            <select
              value={specialtyFilter}
              onChange={(e) => setSpecialtyFilter(e.target.value)}
              className="bg-white/5 border border-white/10 px-4 py-3 rounded-xl text-sm text-white outline-none focus:border-cyan-500/50"
            >
              <option value="">Toutes spécialités</option>
              {SPECIALTIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-white/5 border border-white/10 px-4 py-3 rounded-xl text-sm text-white outline-none focus:border-cyan-500/50"
            >
              <option value="avgScore">Tri: Score</option>
              <option value="totalWins">Tri: Victoires</option>
              <option value="winRate">Tri: Taux</option>
            </select>
          </div>

          {/* Developers grid */}
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="w-10 h-10 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
              <p className="text-[10px] font-black tracking-[0.3em] text-white/40 uppercase">Chargement…</p>
            </div>
          ) : filteredDevelopers.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-10 text-center">
              <p className="text-white/60 font-black italic uppercase tracking-tight">Aucun talent ne correspond</p>
              <button
                onClick={() => { setSearchTerm(""); setSpecialtyFilter(""); }}
                className="mt-4 inline-block px-5 py-2 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-[10px] font-black uppercase tracking-widest text-cyan-300 hover:bg-cyan-500/20"
              >
                Réinitialiser les filtres
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredDevelopers.map((dev) => (
                <DeveloperCard
                  key={dev.id}
                  dev={dev}
                  onView={() => setSelectedDeveloper(dev)}
                  isFavorited={favoriteIds.has(dev.id)}
                  isToggling={togglingFavorites.has(dev.id)}
                  onToggleFavorite={() => handleToggleFavorite(dev.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {view === "MEETINGS" && (
        <div className="space-y-4">
          {meetingsLoading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="w-10 h-10 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
              <p className="text-[10px] font-black tracking-[0.3em] text-white/40 uppercase">Chargement…</p>
            </div>
          ) : meetingsError ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-center text-red-300 text-sm font-mono">
              {meetingsError}
            </div>
          ) : meetings.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-10 text-center">
              <p className="text-white/60 font-black italic uppercase tracking-tight">Aucun meeting planifié</p>
              <p className="text-[10px] text-white/30 mt-2 uppercase tracking-widest">Va dans l'onglet Talents et clique sur Start Meeting.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {meetings.map((m) => (
                <li key={m.id} className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-5 grid grid-cols-1 md:grid-cols-12 gap-3 items-center hover:border-cyan-500/20 transition-all">
                  <div className="md:col-span-4 min-w-0">
                    <p className="text-[9px] font-black text-white/30 uppercase tracking-widest">Candidat</p>
                    <p className="text-sm font-black italic uppercase text-white truncate">{m.candidateName}</p>
                    <p className="text-[10px] font-mono text-white/40 truncate">{m.candidateEmail}</p>
                  </div>
                  <div className="md:col-span-3">
                    <p className="text-[9px] font-black text-white/30 uppercase tracking-widest">Programmé</p>
                    <p className="text-sm font-mono text-cyan-300">{new Date(m.scheduledFor).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
                  </div>
                  <div className="md:col-span-2">
                    <p className="text-[9px] font-black text-white/30 uppercase tracking-widest">Durée</p>
                    <p className="text-sm font-mono text-white/60">{m.durationMinutes} min</p>
                  </div>
                  <div className="md:col-span-1">
                    <span className={`inline-block px-2 py-1 rounded-md text-[9px] font-black uppercase tracking-widest border ${
                      m.status === "SCHEDULED" ? "bg-cyan-500/10 text-cyan-300 border-cyan-500/30" :
                      m.status === "STARTED" ? "bg-amber-500/10 text-amber-300 border-amber-500/30" :
                      m.status === "COMPLETED" ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" :
                      "bg-red-500/10 text-red-300 border-red-500/30"
                    }`}>
                      {m.status}
                    </span>
                  </div>
                  <div className="md:col-span-2 flex justify-end">
                    <Link
                      href={`/meeting/${m.id}`}
                      className="px-4 py-2 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-[10px] font-black uppercase tracking-widest transition-all"
                    >
                      Ouvrir →
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ─── FAVORITES view ─── */}
      {view === "FAVORITES" && (
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="shrink-0 w-9 h-9 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-rose-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
              </svg>
            </div>
            <div>
              <p className="text-[10px] font-black tracking-[0.3em] text-rose-400 uppercase">Mes favoris</p>
              <p className="text-sm text-white/40 leading-none mt-0.5">{favoritesList.length} talent{favoritesList.length !== 1 ? "s" : ""} sauvegardé{favoritesList.length !== 1 ? "s" : ""}</p>
            </div>
          </div>

          {favoritesLoading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="w-10 h-10 border-2 border-rose-400/30 border-t-rose-400 rounded-full animate-spin" />
              <p className="text-[10px] font-black tracking-[0.3em] text-white/40 uppercase">Chargement…</p>
            </div>
          ) : favoritesList.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-12 text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center mx-auto">
                <svg className="w-6 h-6 text-rose-400/50" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                </svg>
              </div>
              <p className="text-white/60 font-black italic uppercase tracking-tight">Aucun favori pour l'instant</p>
              <p className="text-[10px] text-white/30 uppercase tracking-widest">
                Clique sur le cœur d'un talent dans l'onglet Talents pour l'ajouter ici.
              </p>
              <button
                onClick={() => setView("TALENTS")}
                className="mt-2 inline-block px-5 py-2 rounded-xl bg-rose-500/10 border border-rose-500/30 text-[10px] font-black uppercase tracking-widest text-rose-300 hover:bg-rose-500/20 transition-all"
              >
                Explorer les talents →
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {favoritesList.map(({ favoriteId, user }) => {
                const dev: Developer = {
                  id: user.id,
                  firstName: user.firstName,
                  lastName: user.lastName,
                  email: user.email,
                  mainSpecialty: user.mainSpecialty ?? "—",
                  skillTags: user.skillTags,
                  totalChallenges: user.totalChallenges,
                  totalWins: user.totalWins,
                  winRate: user.totalChallenges > 0 ? Math.round((user.totalWins / user.totalChallenges) * 100) : 0,
                  avgScore: 0,
                  avatarUrl: user.avatarUrl ?? `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.firstName}`,
                };
                return (
                  <DeveloperCard
                    key={favoriteId}
                    dev={dev}
                    onView={() => setSelectedDeveloper(dev)}
                    isFavorited
                    isToggling={togglingFavorites.has(user.id)}
                    onToggleFavorite={() => handleToggleFavorite(user.id)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─── Profile detail modal (overlay) ─── */}
      {selectedDeveloper && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[90] flex items-center justify-center p-4 animate-in fade-in duration-200"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setSelectedDeveloper(null); }}
        >
          <div className="absolute inset-0 bg-black/80 backdrop-blur-md" aria-hidden />
          <div className="relative w-full max-w-2xl rounded-3xl border border-cyan-500/20 bg-[#0a0f1a]/95 backdrop-blur-3xl shadow-[0_0_80px_-20px_rgba(0,212,255,0.4)] overflow-hidden animate-in zoom-in-95 slide-in-from-bottom-4 duration-200">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-cyan-500 to-transparent" aria-hidden />
            <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-cyan-500/10 blur-[100px] pointer-events-none" aria-hidden />

            <div className="relative p-7 space-y-5">
              <div className="flex justify-between items-start gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  <img src={selectedDeveloper.avatarUrl} alt="" className={`w-14 h-14 rounded-2xl border-2 border-cyan-500/30 bg-gradient-to-br ${SPECIALTY_GRADIENT[selectedDeveloper.mainSpecialty] || "from-cyan-500/30 to-blue-500/20"} shrink-0`} />
                  <div className="min-w-0">
                    <p className="text-[10px] font-black tracking-[0.3em] text-cyan-400 uppercase">Profil</p>
                    <h3 className="text-xl font-black italic uppercase text-white truncate">{selectedDeveloper.firstName} {selectedDeveloper.lastName}</h3>
                    <p className="text-[11px] text-white/40 font-mono truncate">{selectedDeveloper.email}</p>
                    <span className="inline-block mt-1 px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-widest bg-cyan-500/15 text-cyan-300 border border-cyan-500/20">
                      {selectedDeveloper.mainSpecialty}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedDeveloper(null)}
                  className="shrink-0 w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white/40 hover:text-white transition-all"
                >✕</button>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {[
                  { label: "Score", value: selectedDeveloper.avgScore.toFixed(1), unit: "/10" },
                  { label: "Challenges", value: selectedDeveloper.totalChallenges, unit: "" },
                  { label: "Victoires", value: selectedDeveloper.totalWins, unit: "" },
                  { label: "Win Rate", value: selectedDeveloper.winRate, unit: "%" },
                ].map((s) => (
                  <div key={s.label} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center">
                    <p className="text-2xl font-black italic text-white">{s.value}<span className="text-sm text-white/40">{s.unit}</span></p>
                    <p className="text-[9px] font-black text-white/30 uppercase tracking-widest mt-0.5">{s.label}</p>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <p className="text-[10px] font-black text-white/40 uppercase tracking-widest">Tech Stack</p>
                <div className="flex flex-wrap gap-1.5">
                  {selectedDeveloper.skillTags.map((skill) => (
                    <span key={skill} className="px-2.5 py-1 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-[10px] font-black uppercase tracking-widest text-cyan-300">
                      {skill}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => openScheduleModal(selectedDeveloper)}
                  disabled={!isValidObjectId(selectedDeveloper.id)}
                  title={isValidObjectId(selectedDeveloper.id) ? "Planifier un meeting" : "Profil de démo — id non valide"}
                  className="flex-1 inline-flex items-center justify-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-black py-3 rounded-xl text-[11px] font-black uppercase tracking-[0.2em] transition-all shadow-xl shadow-cyan-500/20 disabled:bg-cyan-500/20 disabled:text-cyan-300/40 disabled:shadow-none disabled:cursor-not-allowed"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                  Start Meeting
                </button>
                <button
                  onClick={() => handleToggleFavorite(selectedDeveloper.id)}
                  disabled={!isValidObjectId(selectedDeveloper.id) || togglingFavorites.has(selectedDeveloper.id)}
                  title={favoriteIds.has(selectedDeveloper.id) ? "Retirer des favoris" : "Ajouter aux favoris"}
                  className={`w-12 shrink-0 flex items-center justify-center rounded-xl border transition-all ${
                    favoriteIds.has(selectedDeveloper.id)
                      ? "bg-rose-500/20 border-rose-500/40 text-rose-400 hover:bg-rose-500/30"
                      : "bg-white/5 border-white/10 text-white/40 hover:border-rose-500/40 hover:text-rose-400"
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  <svg className="w-5 h-5" fill={favoriteIds.has(selectedDeveloper.id) ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Schedule Meeting Modal ─── */}
      {scheduleFor && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200"
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeScheduleModal(); }}
        >
          <div className="absolute inset-0 bg-black/80 backdrop-blur-md" aria-hidden />
          <div className="relative w-full max-w-lg rounded-3xl border border-cyan-500/20 bg-[#0a0f1a]/95 backdrop-blur-3xl shadow-[0_0_80px_-20px_rgba(0,212,255,0.4)] overflow-hidden animate-in zoom-in-95 slide-in-from-bottom-4 duration-200">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-cyan-500 to-transparent" aria-hidden />
            <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-cyan-500/10 blur-[100px] pointer-events-none" aria-hidden />

            <div className="relative p-7 space-y-5">
              <div className="flex items-start gap-4">
                <div className="shrink-0 w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                  <svg className="w-6 h-6 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-black tracking-[0.3em] text-cyan-400 uppercase">Planifier un meeting</p>
                  <h3 className="text-xl font-black italic uppercase text-white truncate">
                    avec {scheduleFor.firstName} {scheduleFor.lastName}
                  </h3>
                  <p className="text-[11px] text-white/40 font-mono mt-1 break-all">{scheduleFor.email}</p>
                </div>
              </div>

              {scheduleResult ? (
                <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                  <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-2">
                    <p className="text-[10px] font-black tracking-[0.3em] text-emerald-400 uppercase">✓ Meeting planifié</p>
                    <p className="text-sm text-white/80">
                      Un email a été envoyé à <span className="font-black text-white">{scheduleResult.candidate.email}</span> avec les détails et le lien de connexion.
                    </p>
                    <div className="rounded-lg bg-black/40 border border-white/10 p-3">
                      <p className="text-[9px] font-black text-white/30 uppercase tracking-widest mb-1">Lien meeting</p>
                      <a href={scheduleResult.meetingLink} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-cyan-400 break-all hover:text-cyan-300">
                        {scheduleResult.meetingLink}
                      </a>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <button onClick={closeScheduleModal} className="flex-1 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-black uppercase tracking-[0.2em] text-white/60 hover:text-white transition-all">
                      Fermer
                    </button>
                    <Link
                      href={`/meeting/${scheduleResult.id}`}
                      className="flex-1 inline-flex items-center justify-center gap-2 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black text-[11px] font-black uppercase tracking-[0.2em] transition-all shadow-xl shadow-cyan-500/30"
                    >
                      Ouvrir →
                    </Link>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleSchedule} className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest ml-0.5">Date et heure</label>
                    <input
                      required
                      type="datetime-local"
                      value={scheduleDate}
                      onChange={(e) => setScheduleDate(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 focus:border-cyan-500/50 p-3.5 rounded-xl text-white text-sm outline-none transition-all"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest ml-0.5">Durée</label>
                    <div className="flex flex-wrap gap-2">
                      {[15, 30, 45, 60, 90].map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setScheduleDuration(m)}
                          className={`px-3 py-2 rounded-lg border text-[10px] font-black uppercase tracking-widest transition-all ${
                            scheduleDuration === m
                              ? "bg-cyan-500/20 border-cyan-500/50 text-cyan-300"
                              : "bg-white/5 border-white/10 text-white/40 hover:text-cyan-400 hover:border-cyan-500/30"
                          }`}
                        >
                          {m} min
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest ml-0.5">Notes (optionnel)</label>
                    <textarea
                      rows={3}
                      maxLength={400}
                      value={scheduleNotes}
                      onChange={(e) => setScheduleNotes(e.target.value)}
                      placeholder="Sujet, agenda, lien Notion / Figma…"
                      className="w-full bg-white/5 border border-white/10 focus:border-cyan-500/50 p-3.5 rounded-xl text-white font-mono text-sm outline-none transition-all resize-none placeholder:text-white/20"
                    />
                  </div>

                  {scheduleError && (
                    <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-xs font-black uppercase tracking-widest text-red-400">
                      ✕ {scheduleError}
                    </div>
                  )}

                  <p className="text-[10px] text-white/30 leading-relaxed">
                    Un email avec le nom de ta company, la date/heure, et un lien de meeting sera envoyé à <span className="text-cyan-400">{scheduleFor.email}</span>.
                  </p>

                  <div className="flex gap-3 pt-1">
                    <button type="button" onClick={closeScheduleModal} disabled={scheduling} className="flex-1 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-black uppercase tracking-[0.2em] text-white/60 hover:text-white transition-all disabled:opacity-50">
                      Annuler
                    </button>
                    <button
                      type="submit"
                      disabled={scheduling || !scheduleDate}
                      className="flex-1 inline-flex items-center justify-center gap-2 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black text-[11px] font-black uppercase tracking-[0.2em] transition-all shadow-xl shadow-cyan-500/30 disabled:bg-cyan-500/20 disabled:text-cyan-300/40 disabled:shadow-none disabled:cursor-not-allowed"
                    >
                      {scheduling ? (
                        <>
                          <span className="w-3.5 h-3.5 border-2 border-black/40 border-t-transparent rounded-full animate-spin" />
                          Envoi…
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
                          Envoyer l'invitation
                        </>
                      )}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent: "cyan" | "emerald" | "violet" | "amber";
}) {
  const acc =
    accent === "cyan" ? { text: "text-cyan-400", bg: "bg-cyan-500/10" } :
    accent === "emerald" ? { text: "text-emerald-400", bg: "bg-emerald-500/10" } :
    accent === "violet" ? { text: "text-violet-400", bg: "bg-violet-500/10" } :
    { text: "text-amber-400", bg: "bg-amber-500/10" };
  return (
    <div className="relative p-5 rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl">
      <div className={`absolute top-0 right-0 w-20 h-20 ${acc.bg} blur-2xl rounded-full -z-10`} />
      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40 mb-2">{label}</p>
      <p className="text-3xl font-black italic tracking-tighter text-white">{value}</p>
      <p className={`mt-1 text-[10px] font-bold uppercase tracking-widest ${acc.text}`}>Live</p>
    </div>
  );
}

function DeveloperCard({
  dev,
  onView,
  isFavorited = false,
  isToggling = false,
  onToggleFavorite,
}: {
  dev: Developer;
  onView: () => void;
  isFavorited?: boolean;
  isToggling?: boolean;
  onToggleFavorite?: () => void;
}) {
  return (
    <div className={`relative rounded-2xl border bg-white/[0.03] backdrop-blur-xl p-5 transition-all group ${
      isFavorited ? "border-rose-500/20 hover:border-rose-500/40" : "border-white/10 hover:border-cyan-500/30 hover:bg-white/[0.05]"
    }`}>
      {/* Heart button — top-right overlay */}
      {onToggleFavorite && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
          disabled={isToggling}
          title={isFavorited ? "Retirer des favoris" : "Ajouter aux favoris"}
          className={`absolute top-3 right-3 w-8 h-8 rounded-lg flex items-center justify-center transition-all z-10 ${
            isFavorited
              ? "bg-rose-500/20 border border-rose-500/30 text-rose-400 hover:bg-rose-500/30"
              : "bg-white/5 border border-white/10 text-white/20 hover:text-rose-400 hover:border-rose-500/30 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100"
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {isToggling ? (
            <span className="w-3 h-3 border border-rose-400/50 border-t-rose-400 rounded-full animate-spin block" />
          ) : (
            <svg className="w-4 h-4" fill={isFavorited ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
            </svg>
          )}
        </button>
      )}

      <button onClick={onView} className="w-full text-left">
      <div className="flex items-start gap-3">
        <img
          src={dev.avatarUrl}
          alt=""
          className={`w-12 h-12 rounded-xl border-2 border-cyan-500/20 bg-gradient-to-br ${SPECIALTY_GRADIENT[dev.mainSpecialty] || "from-cyan-500/30 to-blue-500/20"} group-hover:scale-105 transition-transform shrink-0`}
        />
        <div className="flex-1 min-w-0 pr-8">
          <span className="inline-block px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-widest bg-cyan-500/15 text-cyan-300 border border-cyan-500/20 mb-1.5">
            {dev.mainSpecialty}
          </span>
          <h3 className="text-base font-black italic uppercase text-white truncate">{dev.firstName} {dev.lastName}</h3>
          <p className="text-[10px] text-white/40 font-mono truncate">{dev.email}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-4">
        <div className="rounded-lg border border-white/5 bg-black/20 p-2 text-center">
          <p className="text-xl font-black italic text-cyan-400">{dev.avgScore.toFixed(1)}<span className="text-[10px] text-cyan-400/60">/10</span></p>
          <p className="text-[8px] font-black text-white/30 uppercase tracking-widest">Score</p>
        </div>
        <div className="rounded-lg border border-white/5 bg-black/20 p-2 text-center">
          <p className="text-xl font-black italic text-white">{dev.totalWins}</p>
          <p className="text-[8px] font-black text-white/30 uppercase tracking-widest">Wins</p>
        </div>
        <div className="rounded-lg border border-white/5 bg-black/20 p-2 text-center">
          <p className="text-xl font-black italic text-emerald-400">{dev.winRate}<span className="text-[10px] text-emerald-400/60">%</span></p>
          <p className="text-[8px] font-black text-white/30 uppercase tracking-widest">Rate</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 mt-3">
        {dev.skillTags.slice(0, 3).map((s) => (
          <span key={s} className="text-[9px] bg-white/5 text-white/60 px-2 py-0.5 rounded-md font-mono border border-white/5">{s}</span>
        ))}
        {dev.skillTags.length > 3 && (
          <span className="text-[9px] bg-cyan-500/10 text-cyan-300 px-2 py-0.5 rounded-md font-black uppercase tracking-widest">+{dev.skillTags.length - 3}</span>
        )}
      </div>

      <div className="mt-4 inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.2em] text-cyan-400 group-hover:text-cyan-300">
        Voir profil
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7"/></svg>
      </div>
      </button>
    </div>
  );
}
