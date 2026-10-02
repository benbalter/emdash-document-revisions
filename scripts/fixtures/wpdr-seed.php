<?php
/**
 * Seeds WP Document Revisions in a WordPress Playground with documents that
 * cover what the importer has to carry over. Used by tests/import/import.test.ts.
 *
 * Slugs get a per-run suffix (/fixtures/run.txt) so repeated runs don't
 * collide on the EmDash side.
 *
 * @package emdash-document-revisions
 */

require '/wordpress/wp-load.php';

$run = trim( (string) file_get_contents( '/fixtures/run.txt' ) );

$editor_id = wp_create_user( 'editor', 'password', 'editor@example.com' );
( new WP_User( $editor_id ) )->set_role( 'editor' );
wp_update_user( array( 'ID' => $editor_id, 'display_name' => 'Edna Editor' ) );
// Matches the EmDash dev user, so author mapping by email is exercised.
wp_update_user( array( 'ID' => 1, 'display_name' => 'Ada Admin', 'user_email' => 'dev@emdash.local' ) );

// Use WP Document Revisions' "Document Upload Directory" setting, outside
// the web root, the way security-minded sites run it. Uploads go there
// through the plugin's own upload_dir logic, and _wp_attached_file is
// relative to it, so the exporter has to resolve paths through the plugin.
global $wpdr;
$private_dir = '/wordpress/private-documents';
update_site_option( 'document_upload_directory', $private_dir );
add_filter(
	'upload_dir',
	static function ( $dir ) use ( $wpdr ) {
		return $wpdr->document_upload_dir_set( $dir );
	}
);

foreach ( array( 'In Progress', 'Under Review', 'Final' ) as $state ) {
	if ( ! term_exists( $state, 'workflow_state' ) ) {
		wp_insert_term( $state, 'workflow_state' );
	}
}

// A minimal, valid one-page PDF.
$pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
	. "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
file_put_contents( '/out/fixture.pdf', $pdf );

// One WP revision per call: upload a file version, bump content and excerpt (the log note).
$add_file = function ( $doc_id, $filename, $body, $note, $author ) {
	wp_set_current_user( $author );
	$upload    = wp_upload_bits( $filename, null, $body );
	$type      = wp_check_filetype( $filename );
	$attach_id = wp_insert_attachment(
		array(
			'guid'           => $upload['url'],
			'post_mime_type' => $type['type'] ? $type['type'] : 'text/plain',
			'post_title'     => md5( $filename . microtime() ),
			'post_status'    => 'inherit',
			'post_parent'    => $doc_id,
		),
		$upload['file'],
		$doc_id
	);
	update_post_meta( $doc_id, '_document_attachment_id', $attach_id );
	wp_update_post(
		array(
			'ID'           => $doc_id,
			'post_content' => '<!-- WPDR ' . $attach_id . ' -->' . get_post_meta( $doc_id, '_seed_desc', true ),
			'post_excerpt' => $note,
		)
	);
};

$make = function ( $title, $slug, $author, $desc, $state, $password = '' ) {
	$id = wp_insert_post(
		array(
			'post_title'    => $title,
			'post_name'     => $slug,
			'post_type'     => 'document',
			'post_status'   => 'draft',
			'post_author'   => $author,
			'post_password' => $password,
		)
	);
	update_post_meta( $id, '_seed_desc', $desc );
	if ( $state ) {
		wp_set_object_terms( $id, $state, 'workflow_state' );
	}
	return $id;
};

$finish = function ( $id, $status, $slug ) {
	wp_update_post( array( 'ID' => $id, 'post_status' => $status, 'post_name' => $slug ) );
};

// Published: two file versions, a note-only revision, then a third file.
$h = $make( 'Handbook', "handbook-$run", 1, 'Policies for all staff.', 'Final' );
$add_file( $h, 'handbook.pdf', $pdf, 'Initial upload', 1 );
$add_file( $h, 'handbook.txt', "Handbook v2\n", 'Second draft', $editor_id );
wp_set_current_user( $editor_id );
wp_update_post( array( 'ID' => $h, 'post_excerpt' => 'Fixed a typo in the title', 'post_title' => 'Handbook 2026' ) );
$add_file( $h, 'handbook.txt', "Handbook v3\n", 'Final wording', 1 );
$finish( $h, 'publish', "handbook-$run" );

$b = $make( 'Board Minutes', "minutes-$run", 1, '', 'Under Review' );
$add_file( $b, 'minutes.txt', "Confidential\n", 'March minutes', 1 );
$finish( $b, 'private', "minutes-$run" );

$s = $make( 'Salary Bands', "bands-$run", 1, '', '', 'open-sesame' );
$add_file( $s, 'bands.txt', "Band A\n", 'First version', 1 );
$finish( $s, 'publish', "bands-$run" );

$d = $make( 'Draft Proposal', "proposal-$run", $editor_id, '', 'In Progress' );
$add_file( $d, 'proposal.txt', "Proposal\n", 'Starting point', $editor_id );
$finish( $d, 'draft', "proposal-$run" );

$e = $make( 'Empty Document', "empty-$run", 1, '', '' );
$finish( $e, 'publish', "empty-$run" );

// Scheduled a year out.
$f = $make( 'Next Year Plan', "plan-$run", 1, '', '' );
$add_file( $f, 'plan.txt', "Plan\n", 'Draft plan', 1 );
$future = gmdate( 'Y-m-d H:i:s', time() + YEAR_IN_SECONDS );
// edit_date: wp_update_post otherwise ignores date changes on drafts.
wp_update_post( array( 'ID' => $f, 'post_status' => 'future', 'edit_date' => true, 'post_date' => get_date_from_gmt( $future ), 'post_date_gmt' => $future, 'post_name' => "plan-$run" ) );

// Trashed (exported because the blueprint passes --include-trash).
$t = $make( 'Old Memo', "memo-$run", 1, '', '' );
$add_file( $t, 'memo.txt', "Memo\n", 'Memo', 1 );
$finish( $t, 'publish', "memo-$run" );
wp_trash_post( $t );

// Self-check, read by tests/import/import.test.ts: files really are outside uploads.
$sample = get_attached_file( (int) get_post_meta( $h, '_document_attachment_id', true ) );
// Playground only prints step output on failure, so write it to the mount.
file_put_contents( '/out/seed-check.txt', ( 0 === strpos( (string) $sample, $private_dir ) && is_readable( $sample ) ) ? 'OFFSITE-OK' : "OFFSITE-FAIL $sample" );
