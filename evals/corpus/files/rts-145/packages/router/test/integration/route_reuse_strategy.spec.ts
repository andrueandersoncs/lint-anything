/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import {expect} from '@angular/private/testing/matchers';
import {CommonModule, Location} from '@angular/common';
import {Component, OnDestroy, NgModule, InjectionToken, Inject, signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {
  RouteReuseStrategy,
  DetachedRouteHandle,
  ActivatedRouteSnapshot,
  provideRouter,
  Router,
  NavigationEnd,
  RouterModule,
} from '../../src';
import {Subscription} from 'rxjs';
import {filter} from 'rxjs/operators';
import {By} from '@angular/platform-browser';
import {
  BlankCmp,
  RootCmp,
  SimpleCmp,
  TeamCmp,
  UserCmp,
  ROUTER_DIRECTIVES,
  createRoot,
  advance,
} from './integration_helpers';

export function routeReuseIntegrationSuite() {
  describe('Custom Route Reuse Strategy', () => {
    class AttachDetachReuseStrategy implements RouteReuseStrategy {
      stored: {[k: string]: DetachedRouteHandle} = {};
      pathsToDetach = ['a'];

      shouldDetach(route: ActivatedRouteSnapshot): boolean {
        return (
          typeof route.routeConfig!.path !== 'undefined' &&
          this.pathsToDetach.includes(route.routeConfig!.path)
        );
      }

      store(route: ActivatedRouteSnapshot, detachedTree: DetachedRouteHandle): void {
        this.stored[route.routeConfig!.path!] = detachedTree;
      }

      shouldAttach(route: ActivatedRouteSnapshot): boolean {
        return !!this.stored[route.routeConfig!.path!];
      }

      retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle {
        return this.stored[route.routeConfig!.path!];
      }

      shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
        return future.routeConfig === curr.routeConfig;
      }
    }

    class ShortLifecycle implements RouteReuseStrategy {
      shouldDetach(route: ActivatedRouteSnapshot): boolean {
        return false;
      }
      store(route: ActivatedRouteSnapshot, detachedTree: DetachedRouteHandle): void {}
      shouldAttach(route: ActivatedRouteSnapshot): boolean {
        return false;
      }
      retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
        return null;
      }
      shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
        if (future.routeConfig !== curr.routeConfig) {
          return false;
        }

        if (Object.keys(future.params).length !== Object.keys(curr.params).length) {
          return false;
        }

        return Object.keys(future.params).every((k) => future.params[k] === curr.params[k]);
      }
    }

    it('should be injectable', () => {
      TestBed.configureTestingModule({
        providers: [
          {provide: RouteReuseStrategy, useClass: AttachDetachReuseStrategy},
          provideRouter([]),
        ],
      });

      const router = TestBed.inject(Router);

      expect(router.routeReuseStrategy).toBeInstanceOf(AttachDetachReuseStrategy);
    });

    it('should emit an event when an outlet gets attached/detached', async () => {
      @Component({
        selector: 'container',
        template: `<router-outlet
          (attach)="recordAttached($event)"
          (detach)="recordDetached($event)"
        ></router-outlet>`,
        standalone: false,
      })
      class Container {
        attachedComponents: unknown[] = [];
        detachedComponents: unknown[] = [];

        recordAttached(component: unknown): void {
          this.attachedComponents.push(component);
        }

        recordDetached(component: unknown): void {
          this.detachedComponents.push(component);
        }
      }

      TestBed.configureTestingModule({
        declarations: [Container],
        providers: [{provide: RouteReuseStrategy, useClass: AttachDetachReuseStrategy}],
      });

      const router = TestBed.inject(Router);
      const fixture = await createRoot(router, Container);
      const cmp = fixture.componentInstance;

      router.resetConfig([
        {path: 'a', component: BlankCmp},
        {path: 'b', component: SimpleCmp},
      ]);

      cmp.attachedComponents = [];
      cmp.detachedComponents = [];

      router.navigateByUrl('/a');
      await advance(fixture);
      expect(cmp.attachedComponents.length).toEqual(0);
      expect(cmp.detachedComponents.length).toEqual(0);

      router.navigateByUrl('/b');
      await advance(fixture);
      expect(cmp.attachedComponents.length).toEqual(0);
      expect(cmp.detachedComponents.length).toEqual(1);
      expect(cmp.detachedComponents[0] instanceof BlankCmp).toBe(true);

      // the route will be reused by the `RouteReuseStrategy`
      router.navigateByUrl('/a');
      await advance(fixture);
      expect(cmp.attachedComponents.length).toEqual(1);
      expect(cmp.attachedComponents[0] instanceof BlankCmp).toBe(true);
      expect(cmp.detachedComponents.length).toEqual(1);
      expect(cmp.detachedComponents[0] instanceof BlankCmp).toBe(true);
    });

    it('should support attaching & detaching fragments', async () => {
      const router = TestBed.inject(Router);
      const location = TestBed.inject(Location);
      const fixture = await createRoot(router, RootCmp);

      router.routeReuseStrategy = new AttachDetachReuseStrategy();
      (router.routeReuseStrategy as AttachDetachReuseStrategy).pathsToDetach = ['a', 'b'];
      spyOn(router.routeReuseStrategy, 'retrieve').and.callThrough();

      router.resetConfig([
        {
          path: 'a',
          component: TeamCmp,
          children: [{path: 'b', component: SimpleCmp}],
        },
        {path: 'c', component: UserCmp},
      ]);

      router.navigateByUrl('/a/b');
      await advance(fixture);
      const teamCmp = fixture.debugElement.children[1].componentInstance;
      const simpleCmp = fixture.debugElement.children[1].children[1].componentInstance;
      expect(location.path()).toEqual('/a/b');
      expect(teamCmp).toBeDefined();
      expect(simpleCmp).toBeDefined();
      expect(router.routeReuseStrategy.retrieve).not.toHaveBeenCalled();

      router.navigateByUrl('/c');
      await advance(fixture);
      expect(location.path()).toEqual('/c');
      expect(fixture.debugElement.children[1].componentInstance).toBeInstanceOf(UserCmp);
      // We have still not encountered a route that should be reattached
      expect(router.routeReuseStrategy.retrieve).not.toHaveBeenCalled();

      router.navigateByUrl('/a;p=1/b;p=2');
      await advance(fixture);
      // We retrieve both the stored route snapshots
      expect(router.routeReuseStrategy.retrieve).toHaveBeenCalledTimes(4);
      const teamCmp2 = fixture.debugElement.children[1].componentInstance;
      const simpleCmp2 = fixture.debugElement.children[1].children[1].componentInstance;
      expect(location.path()).toEqual('/a;p=1/b;p=2');
      expect(teamCmp2).toBe(teamCmp);
      expect(simpleCmp2).toBe(simpleCmp);

      expect(teamCmp.route).toBe(router.routerState.root.firstChild);
      expect(teamCmp.route.snapshot).toBe(router.routerState.snapshot.root.firstChild);
      expect(teamCmp.route.snapshot.params).toEqual({p: '1'});
      expect(teamCmp.route.firstChild.snapshot.params).toEqual({p: '2'});
      expect(teamCmp.recordedParams).toEqual([{}, {p: '1'}]);
    });

    it('should support shorter lifecycles', async () => {
      const router = TestBed.inject(Router);
      const location = TestBed.inject(Location);
      const fixture = await createRoot(router, RootCmp);
      router.routeReuseStrategy = new ShortLifecycle();

      router.resetConfig([{path: 'a', component: SimpleCmp}]);

      router.navigateByUrl('/a');
      await advance(fixture);
      const simpleCmp1 = fixture.debugElement.children[1].componentInstance;
      expect(location.path()).toEqual('/a');

      router.navigateByUrl('/a;p=1');
      await advance(fixture);
      expect(location.path()).toEqual('/a;p=1');
      const simpleCmp2 = fixture.debugElement.children[1].componentInstance;
      expect(simpleCmp1).not.toBe(simpleCmp2);
    });

    it('should not mount the component of the previously reused route when the outlet was not instantiated at the time of route activation', async () => {
      @Component({
        selector: 'root-cmp',
        template:
          '<div *ngIf="isToolpanelShowing()"><router-outlet name="toolpanel"></router-outlet></div>',
        standalone: false,
      })
      class RootCmpWithCondOutlet implements OnDestroy {
        private subscription: Subscription;
        public isToolpanelShowing = signal(false);

        constructor(router: Router) {
          this.subscription = router.events
            .pipe(filter((event) => event instanceof NavigationEnd))
            .subscribe(() =>
              this.isToolpanelShowing.set(!!router.parseUrl(router.url).root.children['toolpanel']),
            );
        }

        public ngOnDestroy(): void {
          this.subscription.unsubscribe();
        }
      }

      @Component({
        selector: 'tool-1-cmp',
        template: 'Tool 1 showing',
        standalone: false,
      })
      class Tool1Component {}

      @Component({
        selector: 'tool-2-cmp',
        template: 'Tool 2 showing',
        standalone: false,
      })
      class Tool2Component {}

      @NgModule({
        declarations: [RootCmpWithCondOutlet, Tool1Component, Tool2Component],
        imports: [CommonModule, ...ROUTER_DIRECTIVES],
        providers: [
          provideRouter([
            {path: 'a', outlet: 'toolpanel', component: Tool1Component},
            {path: 'b', outlet: 'toolpanel', component: Tool2Component},
          ]),
        ],
      })
      class TestModule {}

      TestBed.configureTestingModule({imports: [TestModule]});

      const router: Router = TestBed.inject(Router);
      router.routeReuseStrategy = new AttachDetachReuseStrategy();

      const fixture = await createRoot(router, RootCmpWithCondOutlet);

      // Activate 'tool-1'
      router.navigate([{outlets: {toolpanel: 'a'}}]);
      await advance(fixture);
      expect(fixture).toContainComponent(Tool1Component, '(a)');

      // Deactivate 'tool-1'
      router.navigate([{outlets: {toolpanel: null}}]);
      await advance(fixture);
      expect(fixture).not.toContainComponent(Tool1Component, '(b)');

      // Activate 'tool-1'
      router.navigate([{outlets: {toolpanel: 'a'}}]);
      await advance(fixture);
      expect(fixture).toContainComponent(Tool1Component, '(c)');

      // Deactivate 'tool-1'
      router.navigate([{outlets: {toolpanel: null}}]);
      await advance(fixture);
      expect(fixture).not.toContainComponent(Tool1Component, '(d)');

      // Activate 'tool-2'
      router.navigate([{outlets: {toolpanel: 'b'}}]);
      await advance(fixture);
      expect(fixture).toContainComponent(Tool2Component, '(e)');
    });

    it('should not remount a destroyed component', async () => {
      @Component({
        selector: 'root-cmp',
        template: '<div *ngIf="showRouterOutlet()"><router-outlet></router-outlet></div>',
        standalone: false,
      })
      class RootCmpWithCondOutlet {
        public showRouterOutlet = signal(true);
      }

      @NgModule({
        declarations: [RootCmpWithCondOutlet],
        imports: [CommonModule, ...ROUTER_DIRECTIVES],
        providers: [
          {provide: RouteReuseStrategy, useClass: AttachDetachReuseStrategy},
          provideRouter([
            {path: 'a', component: SimpleCmp},
            {path: 'b', component: BlankCmp},
          ]),
        ],
      })
      class TestModule {}
      TestBed.configureTestingModule({imports: [TestModule]});

      const router: Router = TestBed.inject(Router);
      const fixture = await createRoot(router, RootCmpWithCondOutlet);

      // Activate 'a'
      router.navigate(['a']);
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(SimpleCmp))).toBeTruthy();

      // Deactivate 'a' and detach the route
      router.navigate(['b']);
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(SimpleCmp))).toBeNull();

      // Activate 'a' again, the route should be re-attached
      router.navigate(['a']);
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(SimpleCmp))).toBeTruthy();

      // Hide the router-outlet, SimpleCmp should be destroyed
      fixture.componentInstance.showRouterOutlet.set(false);
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(SimpleCmp))).toBeNull();

      // Show the router-outlet, SimpleCmp should be re-created
      fixture.componentInstance.showRouterOutlet.set(true);
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(SimpleCmp))).toBeTruthy();
    });

    it('should allow to attach parent route with fresh child route', async () => {
      const CREATED_COMPS = new InjectionToken<string[]>('CREATED_COMPS');

      @Component({
        selector: 'root',
        template: `<router-outlet></router-outlet>`,
        standalone: false,
      })
      class Root {}

      @Component({
        selector: 'parent',
        template: `<router-outlet></router-outlet>`,
        standalone: false,
      })
      class Parent {
        constructor(@Inject(CREATED_COMPS) createdComps: string[]) {
          createdComps.push('parent');
        }
      }

      @Component({
        selector: 'child',
        template: `child`,
        standalone: false,
      })
      class Child {
        constructor(@Inject(CREATED_COMPS) createdComps: string[]) {
          createdComps.push('child');
        }
      }

      @NgModule({
        declarations: [Root, Parent, Child],
        imports: [CommonModule, ...ROUTER_DIRECTIVES],
        providers: [
          {provide: RouteReuseStrategy, useClass: AttachDetachReuseStrategy},
          {provide: CREATED_COMPS, useValue: []},
          provideRouter([
            {path: 'a', component: Parent, children: [{path: 'b', component: Child}]},
            {path: 'c', component: SimpleCmp},
          ]),
        ],
      })
      class TestModule {}
      TestBed.configureTestingModule({imports: [TestModule]});

      const router = TestBed.inject(Router);
      const fixture = await createRoot(router, Root);
      const createdComps = TestBed.inject(CREATED_COMPS);

      expect(createdComps).toEqual([]);

      router.navigateByUrl('/a/b');
      await advance(fixture);
      expect(createdComps).toEqual(['parent', 'child']);

      router.navigateByUrl('/c');
      await advance(fixture);
      expect(createdComps).toEqual(['parent', 'child']);

      // 'a' parent route will be reused by the `RouteReuseStrategy`, child 'b' should be
      // recreated
      router.navigateByUrl('/a/b');
      await advance(fixture);
      expect(createdComps).toEqual(['parent', 'child', 'child']);
    });

    it('should render child routes on reused list when outer shell is destroyed and recreated', async () => {
      // Regression test for https://github.com/angular/angular/issues/57285
      //
      // Routes: `events` -> `''` (list) -> `:id` (detail) -> `edit`. The list and detail routes
      // are stored by the reuse strategy. The `events` shell is not, so it gets destroyed and
      // recreated every time we navigate away and back.
      //
      // When the shell is recreated, its new router-outlet builds a new OutletContext for the
      // list. But the router-outlet that lives inside the stored list component still points at
      // the ChildrenOutletContexts it was created with. `onOutletDeactivated()` used to swap that
      // object's Map for an empty one, so after the route was re-attached the inner outlet and
      // the router were reading from two different context trees. The router never found the
      // outlet for the `edit` route, so EventEditCmp simply didn't render.

      @Component({
        selector: 'root',
        template: '<router-outlet></router-outlet>',
        standalone: false,
      })
      class Root {}

      // Outer shell. Not reusable, so it's destroyed and recreated whenever we leave /events.
      @Component({
        selector: 'events-shell-cmp',
        template: 'events-shell<router-outlet></router-outlet>',
        standalone: false,
      })
      class EventsShellCmp {}

      // The list. Reusable, so the strategy stores it. Has its own outlet for the detail/edit routes.
      @Component({
        selector: 'event-list-cmp',
        template: 'event-list<router-outlet></router-outlet>',
        standalone: false,
      })
      class EventListCmp {}

      @Component({
        selector: 'event-detail-cmp',
        template: 'event-detail<router-outlet></router-outlet>',
        standalone: false,
      })
      class EventDetailCmp {}

      @Component({
        selector: 'event-edit-cmp',
        template: 'event-edit',
        standalone: false,
      })
      class EventEditCmp {}

      @Component({
        selector: 'chats-cmp',
        template: 'chats',
        standalone: false,
      })
      class ChatsCmp {}

      // Stores a handle for any route marked with `data.reusable: true`, keyed by its routeConfig.
      class ReusableStrategy implements RouteReuseStrategy {
        private handles = new Map<object, DetachedRouteHandle>();

        shouldDetach(route: ActivatedRouteSnapshot): boolean {
          return !!route.routeConfig?.data?.['reusable'];
        }
        store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
          if (route.routeConfig && handle) {
            this.handles.set(route.routeConfig, handle);
          } else if (route.routeConfig) {
            this.handles.delete(route.routeConfig);
          }
        }
        shouldAttach(route: ActivatedRouteSnapshot): boolean {
          return !!(route.routeConfig && this.handles.has(route.routeConfig));
        }
        retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
          return (route.routeConfig && this.handles.get(route.routeConfig)) ?? null;
        }
        shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
          return future.routeConfig === curr.routeConfig;
        }
      }

      @NgModule({
        declarations: [Root, EventsShellCmp, EventListCmp, EventDetailCmp, EventEditCmp, ChatsCmp],
        imports: [...ROUTER_DIRECTIVES],
        providers: [
          {provide: RouteReuseStrategy, useClass: ReusableStrategy},
          provideRouter([
            {
              path: 'events',
              component: EventsShellCmp, // not reusable, destroyed on every navigation away
              children: [
                {
                  path: '',
                  data: {reusable: true},
                  component: EventListCmp, // reusable, stored and reattached
                  children: [
                    {
                      path: ':id',
                      data: {reusable: true},
                      component: EventDetailCmp, // reusable
                      children: [{path: 'edit', component: EventEditCmp}],
                    },
                  ],
                },
              ],
            },
            {path: 'chats', component: ChatsCmp},
          ]),
        ],
      })
      class TestModule {}

      TestBed.configureTestingModule({imports: [TestModule]});
      const fixture = await createRoot(TestBed.inject(Router), Root);
      const router = TestBed.inject(Router);

      // Start on an unrelated route so the list has never been created yet.
      router.navigateByUrl('/chats');
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(ChatsCmp))).toBeTruthy();

      // Go to /events. The shell and the list are both created for the first time.
      router.navigateByUrl('/events');
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(EventListCmp))).toBeTruthy();

      // Leave again. The list is stored, the shell is destroyed.
      router.navigateByUrl('/chats');
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(EventListCmp))).toBeNull();

      // Go back to /events. The shell is rebuilt from scratch and the list is reattached into it.
      // This is the moment the two context trees can drift apart.
      router.navigateByUrl('/events');
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(EventListCmp))).toBeTruthy();

      // Open a detail route. It has to activate inside the reattached list's own outlet.
      router.navigateByUrl('/events/1');
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(EventDetailCmp))).toBeTruthy();

      // Go one level deeper, to the edit route. Before the fix this is where it broke: the
      // router couldn't find the outlet to render into, so EventEditCmp never appeared.
      router.navigateByUrl('/events/1/edit');
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(EventEditCmp))).toBeTruthy();
    });

    it('should render child routes of a reused tab after a sibling tab was shown in the same outlet', async () => {
      // Regression test for https://github.com/angular/angular/issues/57285 (sibling case).
      //
      // Routes: `tabs` (shell, stays alive) -> `tab1` (reusable) / `tab2` (not reusable), each
      // with an `inner` child. `tab1` and `tab2` activate in the *same* shell outlet. When `tab1`
      // is detached its context map must be isolated from `tab2`, otherwise `tab2`'s outlets
      // mutate it and its later destruction wipes it, so `tab1`'s `inner` route can't re-render.

      @Component({selector: 'root', template: '<router-outlet></router-outlet>', standalone: false})
      class Root {}

      @Component({
        selector: 'tabs-shell-cmp',
        template: 'tabs<router-outlet></router-outlet>',
        standalone: false,
      })
      class TabsShellCmp {}

      @Component({
        selector: 'tab1-cmp',
        template: 'tab1<router-outlet></router-outlet>',
        standalone: false,
      })
      class Tab1Cmp {}

      @Component({selector: 'tab1-inner-cmp', template: 'tab1-inner', standalone: false})
      class Tab1InnerCmp {}

      @Component({
        selector: 'tab2-cmp',
        template: 'tab2<router-outlet></router-outlet>',
        standalone: false,
      })
      class Tab2Cmp {}

      @Component({selector: 'tab2-inner-cmp', template: 'tab2-inner', standalone: false})
      class Tab2InnerCmp {}

      class ReusableStrategy implements RouteReuseStrategy {
        private handles = new Map<object, DetachedRouteHandle>();

        shouldDetach(route: ActivatedRouteSnapshot): boolean {
          return !!route.routeConfig?.data?.['reusable'];
        }
        store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
          if (route.routeConfig && handle) {
            this.handles.set(route.routeConfig, handle);
          } else if (route.routeConfig) {
            this.handles.delete(route.routeConfig);
          }
        }
        shouldAttach(route: ActivatedRouteSnapshot): boolean {
          return !!(route.routeConfig && this.handles.has(route.routeConfig));
        }
        retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
          return (route.routeConfig && this.handles.get(route.routeConfig)) ?? null;
        }
        shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
          return future.routeConfig === curr.routeConfig;
        }
      }

      @NgModule({
        declarations: [Root, TabsShellCmp, Tab1Cmp, Tab1InnerCmp, Tab2Cmp, Tab2InnerCmp],
        imports: [...ROUTER_DIRECTIVES],
        providers: [
          {provide: RouteReuseStrategy, useClass: ReusableStrategy},
          provideRouter([
            {
              path: 'tabs',
              component: TabsShellCmp,
              children: [
                {
                  path: 'tab1',
                  data: {reusable: true}, // stored and reattached
                  component: Tab1Cmp,
                  children: [{path: 'inner', component: Tab1InnerCmp}],
                },
                {
                  path: 'tab2', // not reusable, destroyed when leaving
                  component: Tab2Cmp,
                  children: [{path: 'inner', component: Tab2InnerCmp}],
                },
              ],
            },
          ]),
        ],
      })
      class TestModule {}
      TestBed.configureTestingModule({imports: [TestModule]});

      const router = TestBed.inject(Router);
      const fixture = await createRoot(router, Root);

      router.navigateByUrl('/tabs/tab1/inner');
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(Tab1InnerCmp))).toBeTruthy();

      // Switch to the sibling tab. tab1 is detached; tab2 activates in the same shell outlet.
      router.navigateByUrl('/tabs/tab2/inner');
      await advance(fixture);
      expect(fixture.debugElement.query(By.directive(Tab2InnerCmp))).toBeTruthy();
      expect(fixture.debugElement.query(By.directive(Tab1InnerCmp))).toBeNull();

      // Switch back. tab2 is destroyed, tab1 is reattached and navigated deep again.
      router.navigateByUrl('/tabs/tab1/inner');
      await advance(fixture);
      expect(router.url).toEqual('/tabs/tab1/inner');
      expect(fixture.debugElement.query(By.directive(Tab1InnerCmp))).toBeTruthy();
    });

    it('should not try to detach the outlet of a route that does not get to attach a component', async () => {
      @Component({
        selector: 'root',
        template: `<router-outlet></router-outlet>`,
        standalone: false,
      })
      class Root {}

      @Component({
        selector: 'component-a',
        template: 'Component A',
        standalone: false,
      })
      class ComponentA {}

      @Component({
        selector: 'component-b',
        template: 'Component B',
        standalone: false,
      })
      class ComponentB {}

      @NgModule({
        declarations: [ComponentA],
        imports: [RouterModule.forChild([{path: '', component: ComponentA}])],
      })
      class LoadedModule {}

      @NgModule({
        declarations: [Root, ComponentB],
        imports: [ROUTER_DIRECTIVES],
        providers: [
          {provide: RouteReuseStrategy, useClass: AttachDetachReuseStrategy},
          provideRouter([
            {path: 'a', loadChildren: () => LoadedModule},
            {path: 'b', component: ComponentB},
          ]),
        ],
      })
      class TestModule {}

      TestBed.configureTestingModule({imports: [TestModule]});

      const router = TestBed.inject(Router);
      const strategy = TestBed.inject(RouteReuseStrategy);
      const fixture = await createRoot(router, Root);

      spyOn(strategy, 'shouldDetach').and.callThrough();

      router.navigateByUrl('/a');
      await advance(fixture);

      // Deactivate 'a'
      // 'shouldDetach' should not be called for the componentless route
      router.navigateByUrl('/b');
      await advance(fixture);
      expect(strategy.shouldDetach).toHaveBeenCalledTimes(1);
    });
  });
}
