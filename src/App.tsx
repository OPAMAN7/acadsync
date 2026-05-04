import * as React from 'react';
import { useState, useEffect } from 'react';
import { auth, db, googleProvider } from '@/src/lib/firebase';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import { doc, getDoc, setDoc, collection, onSnapshot, query, where, addDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { 
  LayoutDashboard, 
  CheckSquare, 
  Calendar, 
  Settings, 
  LogOut, 
  GraduationCap, 
  Bell, 
  Plus, 
  RefreshCw,
  Clock,
  ExternalLink,
  Github
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { 
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { toast, Toaster } from 'sonner';
import { Task, TimetableEntry, UserSettings, Priority, Status, Source } from '@/src/types';
import { format, addHours, isBefore, parseISO, startOfToday } from 'date-fns';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Components ---

function View({ active, id, children }: { active: string, id: string, children: React.ReactNode }) {
  if (active !== id) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className="w-full h-full"
    >
      {children}
    </motion.div>
  );
}

// --- Main App ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [timetable, setTimetable] = useState<TimetableEntry[]>([]);
  const [settings, setSettings] = useState<UserSettings | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        // Load settings
        const settingsRef = doc(db, 'users', u.uid);
        try {
          const settingsSnap = await getDoc(settingsRef);
          if (settingsSnap.exists()) {
            setSettings(settingsSnap.data() as UserSettings);
          } else {
            const initialSettings: UserSettings = { 
              oauthConnected: false,
              email: u.email || ''
            };
            await setDoc(settingsRef, initialSettings);
            setSettings(initialSettings);
          }
        } catch (err) {
          handleFirestoreError(err, OperationType.GET, `users/${u.uid}`);
        }

        // Sub to tasks
        const tasksQuery = query(collection(db, 'users', u.uid, 'tasks'));
        onSnapshot(tasksQuery, (snap) => {
          setTasks(snap.docs.map(doc => ({ id: doc.id, ...doc.data() }) as Task));
          setTasksLoaded(true);
        }, (err) => handleFirestoreError(err, OperationType.LIST, `users/${u.uid}/tasks`));

        // Sub to timetable
        const ttQuery = query(collection(db, 'users', u.uid, 'timetable'));
        onSnapshot(ttQuery, (snap) => {
          setTimetable(snap.docs.map(doc => ({ id: doc.id, ...doc.data() }) as TimetableEntry));
        }, (err) => handleFirestoreError(err, OperationType.LIST, `users/${u.uid}/timetable`));
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      toast.success('Logged in successfully');
    } catch (err) {
      toast.error('Login failed');
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    toast.info('Logged out');
  };

  const syncClassroom = async () => {
    if (!settings?.googleTokens) {
      toast.error('Connect Google Classroom in Settings first');
      return;
    }

    if (!tasksLoaded) {
      toast.info('Waiting for database connection...');
      return;
    }
    
    toast.promise(
      fetch('/api/classroom/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokens: settings.googleTokens })
      })
      .then(res => res.json())
      .then(async (assignments: any[]) => {
        // Sync to Firestore
        if (user) {
          for (const assignment of assignments) {
            const existing = tasks.find(t => t.externalId === assignment.id);
            if (!existing) {
              try {
                await addDoc(collection(db, 'users', user.uid, 'tasks'), {
                  ...assignment,
                  userId: user.uid,
                  externalId: assignment.id,
                  priority: 'medium',
                  status: 'todo',
                  source: 'classroom',
                  updatedAt: new Date().toISOString()
                });
              } catch (err) {
                handleFirestoreError(err, OperationType.CREATE, `users/${user.uid}/tasks`);
              }
            }
          }
        }
        return assignments.length;
      }),
      {
        loading: 'Syncing assignments...',
        success: (count) => `Synced ${count} assignments`,
        error: 'Sync failed'
      }
    );
  };

  const notifyTelegram = async (message: string) => {
    if (!settings?.telegramToken || !settings?.telegramChatId) {
      console.warn('Telegram not configured');
      return;
    }
    await fetch('/api/notifications/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botToken: settings.telegramToken,
        chatId: settings.telegramChatId,
        message
      })
    });
  };

  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#080808]">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center p-12 bg-zinc-900/10 border border-zinc-800 rounded-[2rem] shadow-2xl max-w-md w-full relative overflow-hidden"
        >
          <div className="absolute -top-24 -right-24 w-64 h-64 bg-indigo-900/20 rounded-full blur-[80px]"></div>
          <div className="bg-white text-black w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6 relative z-10">
            <GraduationCap size={32} />
          </div>
          <h1 className="text-4xl font-serif italic text-white tracking-tight mb-2 relative z-10">AcadSync</h1>
          <p className="text-zinc-500 mb-8 relative z-10">Your ultimate automated academic assistant.</p>
          <Button onClick={handleLogin} className="w-full h-12 text-lg rounded-xl flex gap-2 bg-white text-black hover:bg-zinc-200 border-none relative z-10">
            Sign in with university Google ID
          </Button>
          <p className="mt-6 text-[10px] uppercase tracking-widest text-zinc-600 relative z-10">ScholarOS • Proactive Alerts • Smart Dashboard</p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#080808] text-zinc-300 font-sans">
      <Toaster position="top-center" theme="dark" />
      
      {/* Sidebar */}
      <aside className="w-64 border-r border-zinc-800 flex flex-col p-6">
        <div className="mb-12">
          <h1 className="text-2xl font-serif italic text-white tracking-tight">AcadSync</h1>
          <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 mt-1">Academic Assistant</p>
        </div>

        <nav className="flex-1 flex flex-col gap-6">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-zinc-600 mb-4">Navigation</p>
            <div className="flex flex-col gap-2">
              {[
                { id: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
                { id: 'tasks', icon: CheckSquare, label: 'Task Ledger' },
                { id: 'timetable', icon: Calendar, label: 'Institutional Feed' },
                { id: 'settings', icon: Settings, label: 'Integrations' },
              ].map((item) => (
                <button
                  key={`sidebar-${item.id}`}
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center gap-3 px-4 py-2 rounded-lg transition-all text-sm ${
                    activeTab === item.id 
                    ? 'text-white font-medium' 
                    : 'text-zinc-500 hover:text-white'
                  }`}
                >
                  <div className={`w-1.5 h-1.5 rounded-full transition-all ${activeTab === item.id ? 'bg-indigo-500 shadow-[0_0_8px_#6366f1]' : 'bg-transparent'}`}></div>
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {settings?.oauthConnected && (
            <div>
              <p className="text-[10px] uppercase tracking-widest text-zinc-600 mb-4">Sync Status</p>
              <div className="space-y-3 px-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500">Google Classroom</span>
                  <Badge className="bg-emerald-500/10 text-emerald-500 text-[9px] border-emerald-500/20 px-1.5 py-0">Active</Badge>
                </div>
                {settings.telegramChatId && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-500">Telegram Bot</span>
                    <Badge className="bg-emerald-500/10 text-emerald-500 text-[9px] border-emerald-500/20 px-1.5 py-0">Online</Badge>
                  </div>
                )}
              </div>
            </div>
          )}
        </nav>

        <div className="mt-auto pt-6 border-t border-zinc-800">
          <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 p-4 mb-4">
            <div className="flex items-center gap-3">
              <img src={user.photoURL || ''} className="w-8 h-8 rounded-full border border-zinc-700" />
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-semibold text-white truncate">{user.displayName}</span>
                <span className="text-[9px] text-zinc-500 truncate uppercase tracking-tighter">Student Profile</span>
              </div>
            </div>
          </div>
          <Button variant="ghost" className="w-full justify-start text-zinc-500 hover:text-white text-xs px-2" onClick={handleLogout}>
            <LogOut size={14} className="mr-2" />
            Logout Session
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        <AnimatePresence mode="wait">
          <View active={activeTab} id="dashboard">
            <DashboardView tasks={tasks} timetable={timetable} syncClassroom={syncClassroom} />
          </View>
          <View active={activeTab} id="tasks">
            <TasksView userId={user.uid} tasks={tasks} />
          </View>
          <View active={activeTab} id="timetable">
            <TimetableView userId={user.uid} timetable={timetable} />
          </View>
          <View active={activeTab} id="settings">
            <SettingsView userId={user.uid} settings={settings} />
          </View>
        </AnimatePresence>
      </main>
    </div>
  );
}

// --- Views ---

function DashboardView({ tasks, timetable, syncClassroom }: { tasks: Task[], timetable: TimetableEntry[], syncClassroom: () => void }) {
  const today = format(new Date(), 'eeee').toLowerCase();
  const todayClasses = timetable.filter(t => t.dayOfWeek === today).sort((a, b) => a.startTime.localeCompare(b.startTime));
  
  // Find "Next On Agenda"
  const currentTime = format(new Date(), 'HH:mm');
  const nextClass = todayClasses.find(c => c.startTime > currentTime) || todayClasses[0];

  const upcomingDeadlines = tasks
    .filter(t => t.status !== 'completed' && t.dueDate)
    .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))
    .slice(0, 3);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top Focus Bar */}
      <header className="h-48 border-b border-zinc-800 p-8 flex justify-between items-end relative overflow-hidden shrink-0">
        <div className="relative z-10">
          <h2 className="text-[10px] uppercase tracking-[0.3em] text-indigo-400 mb-2 font-bold">Next On Agenda</h2>
          {nextClass ? (
            <>
              <h3 className="text-5xl font-serif italic text-white leading-none">{nextClass.courseName}</h3>
              <p className="text-zinc-400 mt-3 flex items-center gap-2">
                <span className="text-white">{nextClass.startTime} — {nextClass.endTime}</span> 
                <span className="w-1 h-1 rounded-full bg-zinc-700"></span> 
                {nextClass.room || 'Location TBA'}
              </p>
            </>
          ) : (
            <h3 className="text-5xl font-serif italic text-white leading-none">No remaining classes</h3>
          )}
        </div>
        <div className="text-right relative z-10 flex flex-col items-end gap-4">
          <div className="text-left">
            <p className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Institutional Sync</p>
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse shadow-[0_0_8px_#6366f1]"></div>
              <span className="text-xs text-zinc-300">Ready to fetch Classroom updates</span>
              <Button size="icon" variant="ghost" onClick={syncClassroom} className="w-6 h-6 hover:bg-zinc-800">
                <RefreshCw size={12} />
              </Button>
            </div>
          </div>
        </div>
        <div className="absolute -top-24 -right-24 w-96 h-96 bg-indigo-900/10 rounded-full blur-[100px]"></div>
      </header>

      {/* Content Grid */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-0 divide-x divide-zinc-800 overflow-y-auto">
        {/* Column 1: Academic Sync */}
        <section className="p-6 flex flex-col">
          <div className="flex justify-between items-center mb-6">
            <h4 className="text-xs font-semibold text-white uppercase tracking-tighter">Academic Feed</h4>
            <span className="text-[10px] text-zinc-500 uppercase">Classroom Sync</span>
          </div>
          <div className="space-y-4">
            {tasks.filter(t => t.source === 'classroom' && t.status !== 'completed').slice(0, 4).map((task) => (
              <div key={`dash-classroom-${task.id}`} className="p-4 bg-zinc-900/30 border border-zinc-800 rounded-lg">
                <div className="flex justify-between items-start mb-2">
                  <span className="text-[9px] text-indigo-400 font-mono uppercase truncate max-w-[100px]">{task.courseName || 'General'}</span>
                  <Badge className={`text-[8px] border-[0.5px] uppercase ${
                    task.priority === 'high' ? 'bg-red-900/20 text-red-400 border-red-900/50' : 'bg-zinc-800 text-zinc-500 border-zinc-700'
                  }`}>
                    {task.priority}
                  </Badge>
                </div>
                <p className="text-sm text-zinc-200 mb-2">{task.title}</p>
                <p className="text-[10px] text-zinc-500">Due: {task.dueDate ? format(parseISO(task.dueDate), 'MMM d, HH:mm') : 'No date'}</p>
              </div>
            ))}
            {tasks.filter(t => t.source === 'classroom' && t.status !== 'completed').length === 0 && (
              <div className="border border-dashed border-zinc-800 rounded-lg p-8 text-center text-zinc-600 text-xs italic">
                No active classroom tasks
              </div>
            )}
          </div>
        </section>

        {/* Column 2: Personal Pipeline */}
        <section className="p-6 flex flex-col">
          <div className="flex justify-between items-center mb-6">
            <h4 className="text-xs font-semibold text-white uppercase tracking-tighter">Manual Ledger</h4>
            <CheckSquare size={14} className="text-zinc-600" />
          </div>
          <div className="space-y-4">
            {tasks.filter(t => t.source === 'manual' && t.status !== 'completed').slice(0, 4).map((task) => (
              <div key={`dash-manual-${task.id}`} className="group p-4 border border-zinc-800 hover:border-zinc-700 rounded-lg cursor-pointer transition-all">
                <p className="text-sm text-zinc-200 mb-2 truncate">{task.title}</p>
                <div className="flex items-center justify-between">
                   <span className="text-[10px] text-zinc-500 uppercase tracking-widest">{task.status.replace('_', ' ')}</span>
                   <Badge variant="outline" className="text-[8px] text-zinc-500 border-zinc-800">{task.priority}</Badge>
                </div>
              </div>
            ))}
            {tasks.filter(t => t.source === 'manual' && t.status !== 'completed').length === 0 && (
              <div className="border border-dashed border-zinc-800 rounded-lg p-8 text-center text-zinc-600 text-xs italic">
                Ledger is clear
              </div>
            )}
          </div>
        </section>

        {/* Column 3: Timetable Rail */}
        <section className="p-6 flex flex-col bg-zinc-900/10">
          <h4 className="text-xs font-semibold text-white uppercase tracking-tighter mb-6">Daily Schedule</h4>
          <div className="space-y-0 relative flex-1">
            <div className="absolute left-1 top-0 bottom-0 w-[1px] bg-zinc-800/50"></div>
            
            {todayClasses.map((item) => {
              const isPast = item.endTime < currentTime;
              const isCurrent = currentTime >= item.startTime && currentTime <= item.endTime;
              
              return (
                <div key={`dash-schedule-${item.id}`} className={`pl-6 py-4 relative ${isCurrent ? 'bg-indigo-500/5 rounded-r-lg' : ''}`}>
                  <div className={`absolute left-0 top-6 w-2 h-2 rounded-full -translate-x-[4.5px] transition-all ${
                    isCurrent ? 'bg-indigo-500 shadow-[0_0_8px_#6366f1]' : 
                    isPast ? 'bg-zinc-800' : 'bg-zinc-700'
                  }`}></div>
                  {isCurrent && <p className="text-[9px] text-indigo-400 font-bold mb-1 uppercase tracking-wider">Ongoing</p>}
                  {!isCurrent && !isPast && <p className="text-[9px] text-zinc-500 mb-1">{item.startTime} — {item.endTime}</p>}
                  {isPast && <p className="text-[9px] text-zinc-600 mb-1 line-through">{item.startTime} — {item.endTime}</p>}
                  <p className={`text-sm ${
                    isCurrent ? 'text-white font-medium' : 
                    isPast ? 'text-zinc-600 line-through' : 'text-zinc-400'
                  }`}>
                    {item.courseName}
                  </p>
                  {!isPast && <p className="text-[9px] text-zinc-500 mt-1 uppercase truncate">{item.room || 'TBA'}</p>}
                </div>
              );
            })}
            
            {todayClasses.length === 0 && (
              <p className="text-zinc-600 text-xs italic pl-6 pt-4">No sessions for today.</p>
            )}
          </div>

          <div className="mt-8">
            <div className="p-4 bg-zinc-900 border border-dashed border-zinc-800 rounded-lg text-center">
              <p className="text-[9px] text-zinc-500 mb-2 uppercase tracking-widest">Data Synchronization</p>
              <div className="flex items-center justify-center gap-2 text-[9px] text-emerald-500/80">
                <div className="w-1 h-1 rounded-full bg-emerald-500"></div>
                DB: Synchronized
              </div>
            </div>
          </div>
        </section>
      </div>

      <footer className="h-10 border-t border-zinc-800 px-8 flex items-center justify-between text-[9px] text-zinc-500 tracking-widest uppercase shrink-0">
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-2"><div className="w-1 h-1 rounded-full bg-emerald-500"></div> Edge: Listening</span>
          <span className="flex items-center gap-2"><div className="w-1 h-1 rounded-full bg-indigo-500"></div> Bot: Active</span>
        </div>
        <div>ID: ACAD_SYNC_V1</div>
      </footer>
    </div>
  );
}

function TasksView({ userId, tasks }: { userId: string, tasks: Task[] }) {
  const [filter, setFilter] = useState('all');
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newTask, setNewTask] = useState({ title: '', priority: 'medium' as Priority });

  const addTask = async () => {
    if (!newTask.title) return;
    try {
      await addDoc(collection(db, 'users', userId, 'tasks'), {
        ...newTask,
        userId,
        status: 'todo',
        source: 'manual' as Source,
        updatedAt: new Date().toISOString()
      });
      setNewTask({ title: '', priority: 'medium' });
      setIsAddOpen(false);
      toast.success('Task logged in ledger');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `users/${userId}/tasks`);
    }
  };

  const toggleStatus = async (task: Task) => {
    try {
      const nextStatus: Status = task.status === 'completed' ? 'todo' : 'completed';
      await updateDoc(doc(db, 'users', userId, 'tasks', task.id), { status: nextStatus });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${userId}/tasks/${task.id}`);
    }
  };

  const filtered = tasks.filter(t => filter === 'all' ? true : t.status === filter);

  return (
    <div className="max-w-4xl mx-auto p-12">
      <div className="flex justify-between items-center mb-12">
        <div>
          <h1 className="text-3xl font-serif italic text-white tracking-tight">Task Ledger</h1>
          <p className="text-xs text-zinc-500 uppercase tracking-widest mt-1">Manage academic workload</p>
        </div>
        <Button onClick={() => setIsAddOpen(true)} className="bg-white text-black hover:bg-zinc-200 border-none rounded-lg px-6 h-10 text-xs uppercase tracking-widest font-bold">
          <Plus size={14} className="mr-2" /> Log Task
        </Button>
      </div>

      <Tabs defaultValue="all" onValueChange={setFilter} className="mb-8">
        <TabsList className="bg-zinc-900 border border-zinc-800 p-1 rounded-lg">
          <TabsTrigger value="all" className="rounded-[4px] text-[10px] uppercase tracking-widest">All entries</TabsTrigger>
          <TabsTrigger value="todo" className="rounded-[4px] text-[10px] uppercase tracking-widest">Pending</TabsTrigger>
          <TabsTrigger value="completed" className="rounded-[4px] text-[10px] uppercase tracking-widest">Archived</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="space-y-2">
        {filtered.map((task) => (
          <motion.div 
            layout
            key={`ledger-${task.id}`} 
            className={`flex items-center gap-4 p-4 bg-zinc-900/20 rounded-xl border border-zinc-800 hover:border-zinc-700 group transition-all`}
          >
            <button 
              onClick={() => toggleStatus(task)}
              className={`w-5 h-5 rounded flex items-center justify-center transition-colors border ${
                task.status === 'completed' ? 'bg-indigo-500 border-indigo-500 text-white' : 'border-zinc-700 hover:border-zinc-500'
              }`}
            >
              {task.status === 'completed' && <CheckSquare size={12} />}
            </button>
            <div className="flex-1">
              <h3 className={`text-sm ${task.status === 'completed' ? 'line-through text-zinc-600' : 'text-zinc-200'}`}>
                {task.title}
              </h3>
              <div className="flex items-center gap-4 mt-1">
                {task.courseName && <span className="text-[9px] text-zinc-600 font-mono tracking-tighter">{task.courseName}</span>}
                <span className="text-[9px] text-zinc-700 uppercase tracking-widest font-bold">{task.source}</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <Badge className={`text-[8px] border-[0.5px] uppercase rounded-[4px] ${
                task.priority === 'high' ? 'bg-red-900/20 text-red-400 border-red-900/50' : 'bg-zinc-800 text-zinc-500 border-zinc-700'
              }`}>
                {task.priority}
              </Badge>
              {task.link && (
                <a href={task.link} target="_blank" rel="noreferrer" className="text-zinc-600 hover:text-white transition-colors">
                  <ExternalLink size={14} />
                </a>
              )}
            </div>
          </motion.div>
        ))}
        {filtered.length === 0 && (
          <div className="text-center py-20 border border-dashed border-zinc-800 rounded-2xl">
            <p className="text-zinc-600 text-sm italic">No entries found in this view.</p>
          </div>
        )}
      </div>

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="bg-[#080808] border-zinc-800 text-zinc-300 rounded-[2rem] p-0 overflow-hidden shadow-2xl max-w-sm">
          <div className="p-8 space-y-6">
            <div>
              <h2 className="text-xl font-serif italic text-white">Log Academic Task</h2>
              <p className="text-[10px] uppercase tracking-widest text-zinc-500 mt-1">Add manual workload entry</p>
            </div>
            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest text-zinc-600">Assignment / Task Title</label>
                <Input 
                  placeholder="e.g. Distributed Systems Lab Manual" 
                  value={newTask.title} 
                  onChange={(e) => setNewTask({ ...newTask, title: e.target.value })} 
                  className="bg-zinc-900 border-zinc-800 rounded-lg text-sm focus-visible:ring-indigo-500"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-widest text-zinc-600">Priority Tier</label>
                <div className="flex gap-2">
                  {(['low', 'medium', 'high'] as Priority[]).map((p) => (
                    <Button
                      key={p}
                      type="button"
                      variant={newTask.priority === p ? 'default' : 'outline'}
                      onClick={() => setNewTask({ ...newTask, priority: p })}
                      className={`flex-1 capitalize text-[10px] font-bold tracking-widest rounded-lg h-9 transition-all ${
                        newTask.priority === p ? 'bg-indigo-500 text-white shadow-[0_0_8px_#6366f1]' : 'border-zinc-800 text-zinc-500'
                      }`}
                    >
                      {p}
                    </Button>
                  ))}
                </div>
              </div>
              <Button onClick={addTask} className="w-full bg-white text-black hover:bg-zinc-200 font-bold uppercase tracking-[0.2em] text-[10px] h-12 rounded-xl mt-4">
                Execute Logging
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TimetableView({ userId, timetable }: { userId: string, timetable: TimetableEntry[] }) {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newEntry, setNewEntry] = useState<Partial<TimetableEntry>>({
    courseName: '',
    dayOfWeek: 'monday',
    startTime: '09:00',
    endTime: '10:00',
    room: ''
  });

  const addEntry = async () => {
    if (!newEntry.courseName) return;
    try {
      await addDoc(collection(db, 'users', userId, 'timetable'), {
        ...newEntry,
        userId
      });
      setIsAddOpen(false);
      toast.success('Course added to institutional feed');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `users/${userId}/timetable`);
    }
  };

  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  return (
    <div className="max-w-5xl mx-auto p-12">
      <div className="flex justify-between items-center mb-12">
        <div>
           <h1 className="text-3xl font-serif italic text-white tracking-tight">Institutional Feed</h1>
           <p className="text-xs text-zinc-500 uppercase tracking-widest mt-1">Configure academic schedule for proactive alerts</p>
        </div>
        <Button onClick={() => setIsAddOpen(true)} className="bg-white text-black hover:bg-zinc-200 border-none rounded-lg px-6 h-10 text-xs uppercase tracking-widest font-bold">
           <Plus size={14} className="mr-2" /> Add Session
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-7 gap-px bg-zinc-800 border border-zinc-800 rounded-2xl overflow-hidden">
        {days.map((day) => (
          <div key={day} className="flex flex-col bg-[#080808] min-h-[400px]">
            <h4 className="text-[10px] uppercase font-bold text-zinc-600 tracking-[0.2em] p-4 border-b border-zinc-800 text-center">{day.slice(0,3)}</h4>
            <div className="p-2 space-y-2">
              {timetable.filter(t => t.dayOfWeek === day).sort((a,b) => a.startTime.localeCompare(b.startTime)).map((entry) => (
                <div key={`feed-${entry.id}`} className="bg-zinc-900/40 p-3 rounded-lg border border-zinc-800 group relative">
                  <h5 className="text-[11px] font-bold text-white truncate">{entry.courseName}</h5>
                  <p className="text-[9px] text-zinc-500 mt-1 font-mono">{entry.startTime} - {entry.endTime}</p>
                  <p className="text-[8px] text-zinc-600 uppercase mt-1 truncate">{entry.room}</p>
                  <button 
                    onClick={async () => {
                      try {
                        await deleteDoc(doc(db, 'users', userId, 'timetable', entry.id));
                      } catch (err) {
                        handleFirestoreError(err, OperationType.DELETE, `users/${userId}/timetable/${entry.id}`);
                      }
                    }}
                    className="absolute top-1 right-1 w-4 h-4 bg-zinc-800 text-zinc-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-400 hover:bg-red-400/10"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="bg-[#080808] border-zinc-800 text-zinc-300 rounded-[2rem] p-0 overflow-hidden shadow-2xl max-w-sm">
          <div className="p-8 space-y-6">
            <div>
              <h2 className="text-xl font-serif italic text-white text-center">Schedule Session</h2>
              <p className="text-[10px] uppercase tracking-widest text-zinc-500 mt-1 text-center">Update your weekly institutional cycle</p>
            </div>
            <div className="space-y-4">
              <Input placeholder="Course name..." value={newEntry.courseName} onChange={e => setNewEntry({...newEntry, courseName: e.target.value})} className="bg-zinc-900 border-zinc-800 rounded-lg text-sm" />
              <select 
                className="w-full h-10 px-3 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-300"
                value={newEntry.dayOfWeek}
                onChange={e => setNewEntry({...newEntry, dayOfWeek: e.target.value as any})}
              >
                {days.map(d => <option key={d} value={d} className="bg-[#080808]">{d.charAt(0).toUpperCase() + d.slice(1)}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[9px] uppercase text-zinc-600 ml-1">Start</label>
                  <Input type="time" value={newEntry.startTime} onChange={e => setNewEntry({...newEntry, startTime: e.target.value})} className="bg-zinc-900 border-zinc-800 rounded-lg" />
                </div>
                <div className="space-y-1">
                   <label className="text-[9px] uppercase text-zinc-600 ml-1">End</label>
                  <Input type="time" value={newEntry.endTime} onChange={e => setNewEntry({...newEntry, endTime: e.target.value})} className="bg-zinc-900 border-zinc-800 rounded-lg" />
                </div>
              </div>
              <Input placeholder="Room / Digital Link" value={newEntry.room} onChange={e => setNewEntry({...newEntry, room: e.target.value})} className="bg-zinc-900 border-zinc-800 rounded-lg text-sm" />
              <Button onClick={addEntry} className="w-full bg-white text-black hover:bg-zinc-200 font-bold uppercase tracking-[0.2em] text-[10px] h-12 rounded-xl mt-4">
                Commit to Feed
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SettingsView({ userId, settings }: { userId: string, settings: UserSettings | null }) {
  const [telegram, setTelegram] = useState({ token: '', chatId: '' });

  useEffect(() => {
    if (settings) {
      setTelegram({ token: settings.telegramToken || '', chatId: settings.telegramChatId || '' });
    }
  }, [settings]);

  const saveTelegram = async () => {
    try {
      await updateDoc(doc(db, 'users', userId), {
        telegramToken: telegram.token,
        telegramChatId: telegram.chatId
      });
      toast.success('Telegram configuration synchronized');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${userId}`);
    }
  };

  const connectGoogle = async () => {
    try {
      const res = await fetch('/api/auth/google/url');
      if (!res.ok) throw new Error('Failed to fetch auth URL');
      const { url } = await res.json();
      if (!url) throw new Error('No auth URL returned');
      
      const popup = window.open(url, 'google_auth', 'width=600,height=600');
      
      const handleMsg = async (event: MessageEvent) => {
        if (event.data?.type === 'OAUTH_SUCCESS') {
          const { tokens } = event.data;
          try {
            await updateDoc(doc(db, 'users', userId), {
              googleTokens: tokens,
              oauthConnected: true
            });
            toast.success('Institutional Google sync established');
            window.removeEventListener('message', handleMsg);
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, `users/${userId}`);
          }
        }
      };
      window.addEventListener('message', handleMsg);
    } catch (error) {
      console.error('OAuth initiation error:', error);
      toast.error('Failed to initiate secure handshake');
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-12 space-y-12 overflow-y-auto max-h-full">
      <header>
        <h1 className="text-3xl font-serif italic text-white tracking-tight">System Integrations</h1>
        <p className="text-xs text-zinc-500 uppercase tracking-widest mt-1">Configure automation protocols</p>
      </header>

      <div className="space-y-12">
        <section className="space-y-4">
          <p className="text-[10px] uppercase font-bold text-zinc-600 tracking-widest">Notification Channels</p>
          <div className="bg-zinc-900/20 border border-zinc-800 rounded-2xl p-8 space-y-6">
            <div className="flex items-center gap-3 mb-2">
              <Bell className="text-indigo-500" size={18} />
              <h3 className="text-sm font-semibold text-white">Telegram Proactive Alerts</h3>
            </div>
            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest text-zinc-600">Bot API Key</label>
                <Input type="password" value={telegram.token} onChange={e => setTelegram({...telegram, token: e.target.value})} placeholder="123456:ABC-DEF..." className="bg-zinc-900 border-zinc-800 rounded-lg text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest text-zinc-600">Secure Chat ID</label>
                <Input value={telegram.chatId} onChange={e => setTelegram({...telegram, chatId: e.target.value})} placeholder="987654321" className="bg-zinc-900 border-zinc-800 rounded-lg text-sm" />
              </div>
              <Button onClick={saveTelegram} className="w-full bg-zinc-800 text-white hover:bg-zinc-700 text-[10px] uppercase tracking-widest font-bold h-10 rounded-lg">Sync Credentials</Button>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <p className="text-[10px] uppercase font-bold text-zinc-600 tracking-widest">Academic Sources</p>
          <div className="bg-zinc-900/20 border border-zinc-800 rounded-2xl p-8">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <GraduationCap className="text-emerald-500" size={20} />
                <div>
                   <p className="text-sm font-semibold text-white">Google Classroom API</p>
                   <p className="text-[10px] text-zinc-500 mt-0.5">{settings?.oauthConnected ? 'HANDSHAKE SECURE' : 'CONNECTION STANDBY'}</p>
                </div>
              </div>
              <Button 
                variant="outline"
                className={`text-[10px] uppercase tracking-widest font-bold h-9 rounded-lg border-zinc-800 transition-all ${
                  settings?.oauthConnected ? 'text-emerald-500 border-emerald-500/20 bg-emerald-500/5' : 'text-zinc-400 hover:text-white'
                }`}
                onClick={connectGoogle}
              >
                {settings?.oauthConnected ? 'Reconnect Bridge' : 'Connect Account'}
              </Button>
            </div>
          </div>
        </section>
        
        <section className="space-y-4 pb-12">
          <p className="text-[10px] uppercase font-bold text-zinc-600 tracking-widest">Diagnostic Protocol</p>
          <div className="bg-zinc-900/10 border border-zinc-800 border-dashed rounded-2xl p-8">
              <p className="text-[11px] text-zinc-500 mb-6 leading-relaxed">
                Test the notification gateway by dispatching a diagnostic ping to the connected Telegram instance.
              </p>
              <Button variant="ghost" className="w-full border border-zinc-800 text-[10px] uppercase tracking-widest text-zinc-400 hover:text-white rounded-lg h-10" onClick={() => {
                  if (settings?.telegramToken && settings?.telegramChatId) {
                    toast.promise(
                      fetch('/api/notifications/telegram', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          botToken: settings.telegramToken,
                          chatId: settings.telegramChatId,
                          message: '🔔 AcadSync: diagnostic handshake successful. Proactive alert systems are operational.'
                        })
                      }),
                      {
                        loading: 'Dispatching ping...',
                        success: 'Ping established.',
                        error: 'Diagnostic failure'
                      }
                    );
                  } else {
                    toast.error('Protocol requires credentials');
                  }
              }}>
                Dispatch Diagnostic Notification
              </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
