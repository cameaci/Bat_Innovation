import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout';
import { SurveysPage } from './pages/SurveysPage';
import { ProcessPage } from './pages/ProcessPage';
import { ReviewPage } from './pages/ReviewPage';
import { ExportPage } from './pages/ExportPage';
import { CountsPage } from './pages/CountsPage';
import { EventsPage } from './pages/EventsPage';
import { WatchPage } from './pages/WatchPage';

// HashRouter: the desktop shell serves only app://bat/index.html, so routes live in the fragment.
export function App() {
  return <HashRouter>
    <Routes>
      <Route path="/" element={<SurveysPage />} />
      <Route path="/surveys/:surveyID" element={<AppLayout />}>
        <Route index element={<Navigate to="process" replace />} />
        <Route path="process" element={<ProcessPage />} />
        <Route path="watch" element={<WatchPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="counts" element={<CountsPage />} />
        <Route path="export" element={<ExportPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </HashRouter>;
}
