package main

import (
	"context"
	"fmt"
	"time"

	"github.com/go-logr/logr"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Define the API types based on your CRD.
// These structs are critical for a controller to interact with the custom resource's data.

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// MarketAuctionJob is the Schema for the marketauctionjobs API.
type MarketAuctionJob struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   MarketAuctionJobSpec   `json:"spec,omitempty"`
	Status MarketAuctionJobStatus `json:"status,omitempty"`
}

// MarketAuctionJobSpec defines the desired state of MarketAuctionJob.
// This is where we define the input to our auction.
type MarketAuctionJobSpec struct {
	// JobRequest defines the details of the job to be run.
	JobRequest JobRequest `json:"jobRequest,omitempty"`
	// Bids is a map of bids from various clusters, where the key is the cluster ID.
	Bids map[string]Bid `json:"bids,omitempty"`
	// Constraints imposes limitations on the job, like max runtime or preemption.
	Constraints Constraints `json:"constraints,omitempty"`
}

// JobRequest defines the details of the job to be run.
type JobRequest struct {
	// The name of the job.
	Name string `json:"name,omitempty"`
	// Specifies the GPU and other resource needs.
	ResourceRequirements ResourceRequirements `json:"resourceRequirements,omitempty"`
}

// ResourceRequirements specifies the GPU and other resource needs.
type ResourceRequirements struct {
	// The number of GPUs required.
	GPUs int32 `json:"gpus,omitempty"`
	// The memory required in GiB.
	MemoryGiB int32 `json:"memoryGiB,omitempty"`
}

// Bid represents a single bid from a cluster.
type Bid struct {
	// The price per unit of resource (e.g., per GPU-hour).
	Price float64 `json:"price,omitempty"`
	// The maximum acceptable delay before starting the job (e.g., "10m" for 10 minutes).
	MaxTimeUntilStart string `json:"maxTimeUntilStart,omitempty"`
}

// Constraints imposes limitations on the job, like max runtime or preemption.
type Constraints struct {
	// The maximum runtime for the job (e.g., "1h" for 1 hour).
	MaximumRuntime string `json:"maximumRuntime,omitempty"`
	// Indicates if the job can be interrupted.
	IsPreemptible bool `json:"isPreemptible,omitempty"`
}

// MarketAuctionJobStatus defines the observed state of MarketAuctionJob.
// This is where we output the results of our auction.
type MarketAuctionJobStatus struct {
	// The cluster where the job will run.
	ScheduledCluster string `json:"scheduledCluster,omitempty"`
	// The number of GPUs allocated to the job.
	AllocatedGPUs int32 `json:"allocatedGPUs,omitempty"`
	// The final price paid for the resources.
	ClearingPrice float64 `json:"clearingPrice,omitempty"`
	// When the job is scheduled to begin.
	StartTime metav1.Time `json:"startTime,omitempty"`
	// The current status of the auction (e.g., "Pending", "Scheduled", "Failed").
	State string `json:"state,omitempty"`
	// A human-readable status message.
	Message string `json:"message,omitempty"`
}

// +kubebuilder:object:root=true

// MarketAuctionJobList contains a list of MarketAuctionJob.
type MarketAuctionJobList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []MarketAuctionJob `json:"items"`
}

// MarketAuctionJobReconciler reconciles a MarketAuctionJob object.
type MarketAuctionJobReconciler struct {
	client.Client
	Log    logr.Logger
	Scheme *runtime.Scheme
	Record record.EventRecorder
}

// +kubebuilder:rbac:groups=bidspot.ai,resources=marketauctionjobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=bidspot.ai,resources=marketauctionjobs/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch

// Reconcile is part of the main kubernetes reconciliation loop which aims to
// move the current state of the cluster closer to the desired state.
//
// The Reconcile function takes a context and a Request, and returns a ReconcileResult.
// It is triggered by events on the MarketAuctionJob resource.
func (r *MarketAuctionJobReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	_ = log.FromContext(ctx)

	// Fetch the MarketAuctionJob instance.
	marketAuctionJob := &MarketAuctionJob{}
	err := r.Get(ctx, req.NamespacedName, marketAuctionJob)
	if err != nil {
		if errors.IsNotFound(err) {
			// Request object not found, could have been deleted after reconcile request.
			// Owned objects are automatically garbage collected. For additional cleanup logic use finalizers.
			return ctrl.Result{}, nil
		}
		// Error reading the object - requeue the request.
		return ctrl.Result{}, err
	}

	// 1. Check the job's current status to avoid re-reconciling a completed job.
	if marketAuctionJob.Status.State == "Scheduled" || marketAuctionJob.Status.State == "Failed" {
		r.Log.Info("Job already processed", "job_name", marketAuctionJob.Name, "state", marketAuctionJob.Status.State)
		return ctrl.Result{}, nil
	}

	r.Log.Info("Processing MarketAuctionJob", "job_name", marketAuctionJob.Name)

	// 2. Implement the market auction logic.
	// This is where you would take the bids, constraints, and resource requirements
	// and determine the optimal cluster, price, and start time.
	//
	// You might call a separate function here that contains the complex business logic.
	// For example: `result, err := r.runAuction(marketAuctionJob.Spec)`
	//
	// Example logic (simplified):
	// Find the cluster with the lowest clearing price that meets constraints.
	var bestCluster string
	var lowestPrice float64
	var scheduledStartTime time.Time
	foundCandidate := false

	// A placeholder for your auction algorithm.
	// The `bidspot.ai` name suggests a spot market or auction model.
	// Here, we'll just pick the "best" bid based on a simple heuristic.
	for cluster, bid := range marketAuctionJob.Spec.Bids {
		// A real implementation would consider more factors, like MaxTimeUntilStart
		// and the actual resource availability in the cluster.
		if !foundCandidate || bid.Price < lowestPrice {
			lowestPrice = bid.Price
			bestCluster = cluster
			scheduledStartTime = time.Now().Add(5 * time.Minute) // Placeholder start time
			foundCandidate = true
		}
	}

	// 3. Update the status of the custom resource based on the auction result.
	if foundCandidate {
		marketAuctionJob.Status.State = "Scheduled"
		marketAuctionJob.Status.ScheduledCluster = bestCluster
		marketAuctionJob.Status.AllocatedGPUs = marketAuctionJob.Spec.JobRequest.ResourceRequirements.GPUs
		marketAuctionJob.Status.ClearingPrice = lowestPrice
		marketAuctionJob.Status.StartTime = metav1.NewTime(scheduledStartTime)
		marketAuctionJob.Status.Message = fmt.Sprintf("Job scheduled on cluster %s with %d GPUs for $%.2f", bestCluster, marketAuctionJob.Status.AllocatedGPUs, marketAuctionJob.Status.ClearingPrice)
	} else {
		marketAuctionJob.Status.State = "Failed"
		marketAuctionJob.Status.Message = "Could not find a suitable cluster based on the provided bids."
		r.Record.Event(marketAuctionJob, "Warning", "AuctionFailed", marketAuctionJob.Status.Message)
	}

	// 4. Update the CRD's status subresource.
	if err := r.Status().Update(ctx, marketAuctionJob); err != nil {
		r.Log.Error(err, "Failed to update MarketAuctionJob status")
		return ctrl.Result{}, err
	}

	r.Log.Info("Updated MarketAuctionJob status", "job_name", marketAuctionJob.Name, "status", marketAuctionJob.Status.State)

	// If the job was successfully scheduled, you would now also create a Kubernetes Job
	// object to actually run the workload on the scheduled cluster.
	if marketAuctionJob.Status.State == "Scheduled" {
		r.Log.Info("Job successfully scheduled. Now create the corresponding Kubernetes Job object.")
		// Create the actual Kubernetes Job here.
		// For example: `r.Create(ctx, &corev1.Job{ ... })`
	}

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *MarketAuctionJobReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&MarketAuctionJob{}).
		Complete(r)
}

// +kubebuilder:object:root=true

func init() {
	// Register the MarketAuctionJob and MarketAuctionJobList with the scheme.
	// This makes them known to the controller-runtime's API machinery.
	SchemeBuilder.Register(&MarketAuctionJob{}, &MarketAuctionJobList{})
}

var (
	// SchemeBuilder is the go-to place for adding types to the scheme.
	SchemeBuilder = &runtime.SchemeBuilder{}
)
