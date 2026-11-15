import type { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'television' },
  {
    path: 'television',
    title: 'Televisión en directo · TDT Player',
    loadComponent: () =>
      import('./features/catalogue/catalogue-page.component').then((m) => m.CataloguePageComponent),
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () =>
          import('./features/catalogue/catalogue-home.component').then((m) => m.CatalogueHomeComponent),
      },
      {
        path: ':channelId',
        loadComponent: () => import('./features/watch/watch-page.component').then((m) => m.WatchPageComponent),
      },
    ],
  },
  {
    path: 'schedule',
    title: 'Parrilla de programación · TDT Player',
    loadComponent: () => import('./features/schedule/schedule-page.component').then((m) => m.SchedulePageComponent),
  },
  { path: '**', redirectTo: 'television' },
];
