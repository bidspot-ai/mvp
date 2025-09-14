package main

import (
	"context"
	"testing"
	"time"

	"github.com/go-logr/logr/testr"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/record"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestMarketAuctionJobReconciler_Reconcile_SchedulesBestBid(t *testing.T) {
	scheme := runtime.NewScheme()
	reconciler := &MarketAuctionJobReconciler{
		Log:    testr.New(t),
		Scheme: scheme,
		Record: record.NewFakeRecorder(10),
	}

	job := &MarketAuctionJob{
		ObjectMeta: metav1.ObjectMeta{Name: "test-job", Namespace: "default"},
		Spec: MarketAuctionJobSpec{
			JobRequest: JobRequest{
				Name: "test-job",
				ResourceRequirements: ResourceRequirements{GPUs: 2, MemoryGiB: 16},
			},
			Bids: map[string]Bid{
				"cluster-a": {Price: 2.0, MaxTimeUntilStart: "5m"},
				"cluster-b": {Price: 1.5, MaxTimeUntilStart: "10m"},
			},
			Constraints: Constraints{MaximumRuntime: "1h", IsPreemptible: false},
		},
	}

	ctx := context.Background()
	// Simulate the Get and Status().Update methods
	getCalled := false
	updateCalled := false
	reconciler.Client = &fakeClient{
		getFunc: func(_ context.Context, _ interface{}, obj interface{}) error {
			getCalled = true
			*obj.(*MarketAuctionJob) = *job
			return nil
		},
		statusUpdateFunc: func(_ context.Context, obj interface{}) error {
			updateCalled = true
			return nil
		},
	}

	_, err := reconciler.Reconcile(ctx, fakeRequest{"default", "test-job"})
	if err != nil {
		t.Fatalf("Reconcile failed: %v", err)
	}
	if !getCalled || !updateCalled {
		t.Error("Expected Get and Status().Update to be called")
	}
	if job.Status.ScheduledCluster != "cluster-b" {
		t.Errorf("Expected best bid to be scheduled (cluster-b), got %s", job.Status.ScheduledCluster)
	}
	if job.Status.State != "Scheduled" {
		t.Errorf("Expected job state to be Scheduled, got %s", job.Status.State)
	}
}

// --- Fakes for testing ---
type fakeClient struct {
	client.Client
	getFunc        func(context.Context, interface{}, interface{}) error
	statusUpdateFunc func(context.Context, interface{}) error
}

func (f *fakeClient) Get(ctx context.Context, key interface{}, obj interface{}) error {
	return f.getFunc(ctx, key, obj)
}

func (f *fakeClient) Status() client.StatusWriter {
	return f
}

func (f *fakeClient) Update(ctx context.Context, obj interface{}, opts ...client.UpdateOption) error {
	return f.statusUpdateFunc(ctx, obj)
}

type fakeRequest struct {
	Namespace string
	Name      string
}

func (r fakeRequest) NamespacedName() interface{} {
	return r
}
