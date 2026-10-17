import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Booking = { id: string; client: string; email: string; service: string; day: number; time: string; duration: number; status: "Confirmed" | "Pending" };

const days = ["Mon 5", "Tue 6", "Wed 7", "Thu 8", "Fri 9"];
const timeSlots = ["09:00", "10:00", "11:00", "12:00", "14:00", "15:00", "16:00"];

const seed: Booking[] = [
  { id: "b1", client: "Anna Lee", email: "anna@example.com", service: "Consultation", day: 0, time: "09:00", duration: 60, status: "Confirmed" },
  { id: "b2", client: "Marc Diaz", email: "marc@example.com", service: "Styling", day: 1, time: "11:00", duration: 90, status: "Confirmed" },
  { id: "b3", client: "Priya Patel", email: "priya@example.com", service: "Follow-up", day: 3, time: "14:00", duration: 30, status: "Pending" },
];

const services = ["Consultation", "Styling", "Follow-up", "Training", "Site review"];

export default function App() {
  const [bookings, setBookings] = useState(seed);
  const [client, setClient] = useState("");
  const [email, setEmail] = useState("");
  const [service, setService] = useState("");
  const [day, setDay] = useState("0");
  const [time, setTime] = useState("09:00");

  const taken = (d: number, t: string) => bookings.some(b => b.day === d && b.time === t);

  const book = () => {
    if (!client.trim() || !email.trim() || !service) return;
    if (taken(Number(day), time)) return;
    setBookings([...bookings, {
      id: "b" + (bookings.length + 1), client, email, service,
      day: Number(day), time, duration: 60, status: "Confirmed" as const,
    }]);
    setClient(""); setEmail(""); setService("");
  };

  const cancel = (id: string) => setBookings(bookings.filter(b => b.id !== id));

  const weekCount = bookings.length;

  return (
    <div className="min-h-screen bg-slate-950 p-6 font-sans text-slate-100">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="bg-gradient-to-r from-sky-300 to-cyan-300 bg-clip-text text-transparent">Snow Seasons Tech</span>
            <span className="text-slate-300"> · Booking</span>
          </h1>
          <p className="text-sm text-slate-400">Booking-only tool — white-label demo</p>
        </div>
        <Badge variant="outline" className="border-sky-500/40 text-sky-300 text-xs">Your Brand Here</Badge>
      </header>

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Card className="border-slate-800 bg-slate-900"><CardHeader><CardTitle className="text-sm text-slate-400">Bookings this week</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold">{weekCount}</p></CardContent></Card>
        <Card className="border-slate-800 bg-slate-900"><CardHeader><CardTitle className="text-sm text-slate-400">Confirmed</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-emerald-400">{bookings.filter(b => b.status === "Confirmed").length}</p></CardContent></Card>
        <Card className="border-slate-800 bg-slate-900"><CardHeader><CardTitle className="text-sm text-slate-400">Open slots</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-sky-400">{days.length * timeSlots.length - weekCount}</p></CardContent></Card>
      </div>

      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="border-slate-800 bg-slate-900">
          <CardHeader><CardTitle>New booking</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div><Label className="text-xs text-slate-400">Client name</Label><Input value={client} onChange={e => setClient(e.target.value)} placeholder="Jane Doe" className="border-slate-700 bg-slate-950" /></div>
            <div><Label className="text-xs text-slate-400">Email</Label><Input value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@example.com" className="border-slate-700 bg-slate-950" /></div>
            <div>
              <Label className="text-xs text-slate-400">Service</Label>
              <Select value={service} onValueChange={setService}>
                <SelectTrigger className="border-slate-700 bg-slate-950"><SelectValue placeholder="Choose service" /></SelectTrigger>
                <SelectContent>{services.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-slate-400">Day</Label>
                <Select value={day} onValueChange={setDay}>
                  <SelectTrigger className="border-slate-700 bg-slate-950"><SelectValue /></SelectTrigger>
                  <SelectContent>{days.map((d, i) => <SelectItem key={d} value={String(i)}>{d}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-slate-400">Time</Label>
                <Select value={time} onValueChange={setTime}>
                  <SelectTrigger className="border-slate-700 bg-slate-950"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {timeSlots.map(t => (
                      <SelectItem key={t} value={t} disabled={taken(Number(day), t)}>{t}{taken(Number(day), t) ? " (taken)" : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button className="w-full bg-gradient-to-r from-sky-500 to-cyan-500 hover:from-sky-400 hover:to-cyan-400" onClick={book} disabled={!client.trim() || !email.trim() || !service || taken(Number(day), time)}>
              Confirm booking
            </Button>
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          <div className="grid gap-3 md:grid-cols-5">
            {days.map((d, idx) => (
              <Card key={d} className="min-h-48 border-slate-800 bg-slate-900">
                <CardHeader><CardTitle className="text-sm">{d}</CardTitle></CardHeader>
                <CardContent className="space-y-1.5">
                  {timeSlots.map(t => {
                    const b = bookings.find(x => x.day === idx && x.time === t);
                    return b ? (
                      <div key={t} className="group rounded-lg bg-sky-500/15 p-2 text-xs border border-sky-500/30">
                        <p className="font-semibold text-sky-200">{t} · {b.client}</p>
                        <p className="text-sky-300/80">{b.service}</p>
                        <button onClick={() => cancel(b.id)} className="mt-1 text-[10px] text-rose-400 opacity-0 group-hover:opacity-100">Cancel</button>
                      </div>
                    ) : (
                      <div key={t} className="rounded-lg border border-dashed border-slate-700 p-2 text-xs text-slate-500">{t} — open</div>
                    );
                  })}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}