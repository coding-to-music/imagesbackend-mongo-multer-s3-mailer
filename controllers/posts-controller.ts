import HttpError from "../models/http-error";
import { NextFunction, Request, Response } from "express";
import { validationResult } from "express-validator";
import getCoordsFromAddress from "../util/location";
import PostModel from "../models/postSchema";
import UserModel from "../models/userSchema";
import { startSession } from "mongoose";
import { GetUserAuthHeader } from "../models/interfaces";
import CommentModel from "../models/commentSchema";

export async function getFeed(req: Request, res: Response, next: NextFunction) {
  let feedPosts;
  try {
    //50 most recent posts, newest created first
    feedPosts = await PostModel.find().sort({ createDate: 1 }).limit(50);
    res.status(200).json(
      feedPosts.map((p) => {
        return p.toObject({ getters: true });
      })
    );
  } catch (err) {
    return next(new HttpError("Error fetching feed.", "500"));
  }
}

export async function getPostById(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const postId = req.params.pid;
  let filteredPosts;
  try {
    filteredPosts = await PostModel.findById(postId);
    res.status(200).json(filteredPosts!.toObject({ getters: true }));
  } catch (err) {
    return next(
      new HttpError("Could not find a post for the provided id.", "404")
    );
  }
}

export async function getPostsByUserId(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const creatorId = req.params.uid;
  let filteredPosts;
  try {
    filteredPosts = await PostModel.find({ creatorId });
  } catch (err) {
    return next(
      new HttpError("A communication error occured, please try again.", "500")
    );
  }

  if (filteredPosts.length === 0) {
    const error: NodeJS.ErrnoException = new HttpError(
      "Could not find any posts for the provided user.",
      "404"
    );
    return next(error);
  }
  res.status(200).json(
    filteredPosts.map((p) => {
      return p.toObject({ getters: true });
    })
  );
}

export async function createPost(req: any, res: Response, next: NextFunction) {
  const error = validationResult(req);
  if (!error.isEmpty()) {
    return next(new HttpError("Invalid Inputs, Please check inputs", "422"));
  }
  const { title, description, address } = req.body;
  let coordinates;
  try {
    coordinates = await getCoordsFromAddress(address);
  } catch (error) {
    return next(error);
  }

  const createdPlace = new PostModel({
    title,
    description,
    creatorId: req.userData.userId,
    address,
    coordinates,
    createDate: new Date(Date.now()).toISOString(),
    image: req.file?.location,
  });

  let user;
  try {
    user = await UserModel.findById(req.userData.userId);
  } catch (err) {
    return next(new HttpError("Could not find user with provided ID", "404"));
  }

  try {
    const postSession = await startSession();
    postSession.startTransaction();
    await createdPlace.save({ session: postSession });
    user!.posts.push(createdPlace);
    await user!.save({ session: postSession });
    await postSession.commitTransaction();
  } catch (err) {
    return next(
      new HttpError("A communication error occured, please try again.", "500")
    );
  }

  res.status(201).json(createdPlace.toObject({ getters: true }));
}

export async function editPost(
  req: GetUserAuthHeader,
  res: Response,
  next: NextFunction
) {
  const postId = req.params.pid;
  let filteredPost;
  const error = validationResult(req);
  if (!error.isEmpty()) {
    return next(new HttpError("Invalid Inputs, Please check inputs", "422"));
  }
  const { title, description, address } = req.body;

  try {
    filteredPost = await PostModel.findById(postId);
  } catch (err) {
    return next(new HttpError("Could not find a matching post ID.", "404"));
  }

  if (req.userData.userId !== filteredPost?.creatorId.toString()) {
    return next(new HttpError("This isn't your post!", "401"));
  }

  let coordinates;

  if (filteredPost!.address !== address) {
    try {
      coordinates = await getCoordsFromAddress(address);
      filteredPost!.title = title;
      filteredPost!.description = description;
      filteredPost!.coordinates = coordinates;
      filteredPost!.address = address;
    } catch (error) {
      return next(
        new HttpError(
          "An error occured translating location, please try again.",
          "500"
        )
      );
    }
  } else {
    filteredPost!.title = title;
    filteredPost!.description = description;
  }

  try {
    await filteredPost!.save();
  } catch (err) {
    return next(
      new HttpError("A communication error occured, please try again.", "500")
    );
  }

  res.status(200).json(filteredPost!.toObject({ getters: true }));
}

export async function deletePost(
  req: GetUserAuthHeader,
  res: Response,
  next: NextFunction
) {
  const postId = req.params.pid;

  let filteredPost;

  try {
    //populate returns document from user collection of who created post nested in creatorId key
    //this is possible due to the ref set in the postSchema
    filteredPost = await PostModel.findById(postId).populate("creatorId");
  } catch (err) {
    return next(
      new HttpError("A communication error occured, please try again.", "500")
    );
  }
  if (!filteredPost) {
    return next(new HttpError("Could not find a matching post ID.", "404"));
  }

  if (filteredPost.creatorId.id !== req.userData.userId) {
    return next(new HttpError("This isn't your post!", "401"));
  }

  const imagePath = filteredPost.image;

  try {
    const deleteSession = await startSession();
    deleteSession.startTransaction();
    await filteredPost.remove({ session: deleteSession });
    //this is where populate comes into play. it allows us to delete the post from the user collection
    //in the same session without have to find it with a second search
    filteredPost!.creatorId.posts.pull(filteredPost);
    await filteredPost!.creatorId.save({
      session: deleteSession,
    });
    await deleteSession.commitTransaction();
  } catch (err) {
    return next(
      new HttpError("A communication error occured, please try again.", "500")
    );
  }

  //TODO figure out how to delete from S3
  // fs.unlink(imagePath, (err) => {
  //   console.warn(err);
  // });

  res.status(200).json({ message: "deleted post" });
}

export async function createComment(
  req: GetUserAuthHeader,
  res: Response,
  next: NextFunction
) {
  console.log("at the comment API endpoint");
  const error = validationResult(req);
  if (!error.isEmpty()) {
    return next(new HttpError("Invalid Inputs, Please check inputs", "422"));
  }
  console.log(req.body);
  const { comment, postId } = req.body;

  const createdComment = new CommentModel({
    creatorId: req.userData.userId,
    createDate: new Date(Date.now()).toISOString(),
    comment: comment,
    post: postId,
  });

  let user;
  try {
    user = await UserModel.findById(req.userData.userId);
    console.log(user);
  } catch (err) {
    return next(
      new HttpError("Could not find your userID, please try again", "404")
    );
  }

  let post;
  try {
    post = await PostModel.findById(postId);
    console.log(post);
  } catch (err) {
    return next(new HttpError("Could not find that post", "404"));
  }

  try {
    const commentSession = await startSession();
    commentSession.startTransaction();
    await createdComment.save({ session: commentSession });
    user!.comments.push(createdComment);
    await user!.save({ session: commentSession });
    post!.comments.push(createdComment);
    await post!.save({ session: commentSession });
    await commentSession.commitTransaction();
  } catch (err) {
    console.log(err);
    return next(
      new HttpError("A communication error occured, please try again.", "500")
    );
  }

  res.status(201).json(createdComment.toObject({ getters: true }));
}

export async function getComments(
  req: GetUserAuthHeader,
  res: Response,
  next: NextFunction
) {
  const post = req.params.pid;
  let comments;
  try {
    comments = await CommentModel.find({ post }).populate("creatorId");
  } catch (err) {
    console.warn(err);
    return next(
      new HttpError("A communication error occured, please try again.", "500")
    );
  }
  if (comments.length === 0) {
    res.status(200).json({ message: null });
  } else {
    res.status(200).json(
      comments.map((p) => {
        return p.toObject({ getters: true });
      })
    );
  }
}
