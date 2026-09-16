import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/lib/auth';

export default function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  }
  if (!user) {
    if (localStorage.getItem('rvp_kata_cabin_installation_key')) {
      return <Navigate to="/kata-cabin" replace />;
    }
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
